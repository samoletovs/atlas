/**
 * Global daily USD budget cap — defense-in-depth on top of the per-user
 * quota in `quota.ts`.
 *
 * Per-user quota already keeps any single account from draining tokens
 * (5 lessons/day, 30 asks/day by default). This module adds a hard
 * ceiling on aggregate spend across ALL users so a public sign-up surge
 * can never blow the Azure OpenAI bill past a configured number.
 *
 * The general cap is in-memory and per Azure Functions instance. On a Consumption
 * plan the runtime may scale out, so the true ceiling is
 *   N_warm_instances × ATLAS_DAILY_BUDGET_USD
 * That's acceptable defense-in-depth for a research-grade product; a
 * single misbehaving instance still gets cut off quickly.
 *
 * App Settings overrides:
 *   ATLAS_DAILY_BUDGET_USD   per-instance daily $ ceiling (default 5.00)
 *   ATLAS_SOL_DAILY_BUDGET_USD shared Sol ceiling (0..0.10, default 0.10)
 *
 * Sol additionally reserves against one durable Cosmos row per UTC day.
 * Conditional writes share that allowance across users, restarts and instances.
 */

import { usersContainer } from './cosmos.js';
import type { ActualModel } from './openaiClient.js';

const DEFAULT_DAILY_BUDGET_USD = 5.0;
const SOL_DAILY_MAX_USD = 0.10;
const SOL_BUDGET_PARTITION = '__atlas_sol_budget__';

interface SolBudget {
  id: string;
  userId: string;
  kind: 'model-budget';
  date: string;
  reservedMicroUsd: number;
  ttl: -1;
  _etag?: string;
}

// Global short-context USD/M. Reservations never assume a cache hit.
export const MODEL_PRICES: Record<ActualModel, { input: number; output: number; cachedInput: number }> = {
  'gpt-6-luna': { input: 0.10, output: 0.50, cachedInput: 0.01 },
  'gpt-6-sol': { input: 2.00, output: 10.00, cachedInput: 0.20 },
  'gpt-4o-mini': { input: 0.15, output: 0.60, cachedInput: 0.075 },
  'gpt-4.1': { input: 2.00, output: 8.00, cachedInput: 0.50 },
};

interface DailyBudget {
  date: string;
  costUsd: number;
}

let dailyBudget: DailyBudget = { date: '', costUsd: 0 };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDailyBudgetUsd(): number {
  const raw = process.env.ATLAS_DAILY_BUDGET_USD;
  const parsed = raw === undefined ? DEFAULT_DAILY_BUDGET_USD : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('ATLAS_DAILY_BUDGET_USD must be a positive number');
  }
  return parsed;
}

function ensureToday(): void {
  const today = todayKey();
  if (dailyBudget.date !== today) {
    dailyBudget = { date: today, costUsd: 0 };
  }
}

function hasStatus(error: unknown, code: number): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function reserveSolCost(microUsd: number): Promise<void> {
  const raw = process.env.ATLAS_SOL_DAILY_BUDGET_USD;
  const limit = raw === undefined ? SOL_DAILY_MAX_USD : Number(raw);
  if (raw?.trim() === '' || !Number.isFinite(limit) || limit < 0 || limit > SOL_DAILY_MAX_USD) {
    throw new Error('ATLAS_SOL_DAILY_BUDGET_USD must be between 0 and 0.10');
  }
  const limitMicroUsd = Math.floor(limit * 1_000_000);
  const exhausted = () => new BudgetReservationError('Sol daily budget cannot cover this request. Try after the next UTC day.');
  if (microUsd > limitMicroUsd) throw exhausted();
  const date = todayKey();
  const id = `sol-budget-${date}`;
  const container = usersContainer();
  const item = container.item(id, SOL_BUDGET_PARTITION);
  for (let attempt = 0; attempt < 3; attempt++) {
    let current: SolBudget | undefined;
    try {
      const { resource } = await item.read<SolBudget>();
      current = resource;
      if (!current || current.id !== id || current.userId !== SOL_BUDGET_PARTITION ||
          current.kind !== 'model-budget' || current.date !== date ||
          !Number.isSafeInteger(current.reservedMicroUsd) || current.reservedMicroUsd < 0) {
        throw new Error('Invalid Sol budget state');
      }
    } catch (error: unknown) {
      if (!hasStatus(error, 404)) throw error;
    }
    const reservedMicroUsd = (current?.reservedMicroUsd ?? 0) + microUsd;
    if (reservedMicroUsd > limitMicroUsd) throw exhausted();
    const next: SolBudget = {
      id, userId: SOL_BUDGET_PARTITION, kind: 'model-budget', date, reservedMicroUsd, ttl: -1,
    };
    try {
      if (current) {
        const etag = current._etag;
        if (!etag) throw new Error('Invalid Sol budget state');
        await item.replace(next, {
          accessCondition: { type: 'IfMatch', condition: etag },
        });
      } else {
        await container.items.create(next);
      }
      return;
    } catch (error: unknown) {
      if (!hasStatus(error, current ? 412 : 409)) throw error;
    }
  }
  throw new Error('Sol budget reservation conflicted repeatedly; no model call admitted');
}

export interface BudgetExceeded {
  exceeded: true;
  budgetUsd: number;
  spentUsd: number;
  resetAt: string;
}
export interface BudgetOk {
  exceeded: false;
  budgetUsd: number;
  spentUsd: number;
}

export function checkBudget(): BudgetExceeded | BudgetOk {
  ensureToday();
  const budget = getDailyBudgetUsd();
  const spent = dailyBudget.costUsd;
  if (spent >= budget) {
    const d = new Date();
    const resetAt = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1),
    ).toISOString();
    return { exceeded: true, budgetUsd: budget, spentUsd: Number(spent.toFixed(4)), resetAt };
  }
  return { exceeded: false, budgetUsd: budget, spentUsd: Number(spent.toFixed(4)) };
}

/**
 * Reserve uncached input and the full completion ceiling, including reasoning.
 * Synchronous admission prevents concurrent requests overshooting this instance.
 * Failed calls retain their reservation because remote billing may have occurred.
 */
export async function recordEstimatedCost(
  model: ActualModel, maxTokens: number, inputTokens: number,
): Promise<void> {
  ensureToday();
  const rate = MODEL_PRICES[model];
  if (!rate) throw new Error('No price configured for the actual model');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 ||
      !Number.isInteger(inputTokens) || inputTokens < 0) {
    throw new Error('Invalid model token reservation');
  }
  const microUsd = Math.ceil(inputTokens * rate.input + maxTokens * rate.output);
  const cost = microUsd / 1_000_000;
  if (dailyBudget.costUsd + cost > getDailyBudgetUsd()) {
    throw new BudgetReservationError();
  }
  dailyBudget.costUsd += cost;
  if (model === 'gpt-6-sol') await reserveSolCost(microUsd);
}

export class BudgetReservationError extends Error {
  constructor(message = 'Atlas daily AI budget cannot cover this request. Try after the next UTC day.') {
    super(message);
    this.name = 'BudgetReservationError';
  }
}

export function getBudgetStats(): {
  date: string;
  budgetUsd: number;
  spentUsd: number;
} {
  ensureToday();
  return {
    date: dailyBudget.date,
    budgetUsd: getDailyBudgetUsd(),
    spentUsd: Number(dailyBudget.costUsd.toFixed(4)),
  };
}
