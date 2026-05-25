/**
 * Global daily USD budget cap — defense-in-depth on top of the per-user
 * quota in `quota.ts`.
 *
 * Per-user quota already keeps any single account from draining tokens
 * (5 lessons/day, 30 asks/day by default). This module adds a hard
 * ceiling on aggregate spend across ALL users so a public sign-up surge
 * can never blow the Azure OpenAI bill past a configured number.
 *
 * State is in-memory and per Azure Functions instance. On a Consumption
 * plan the runtime may scale out, so the true ceiling is
 *   N_warm_instances × ATLAS_DAILY_BUDGET_USD
 * That's acceptable defense-in-depth for a research-grade product; a
 * single misbehaving instance still gets cut off quickly.
 *
 * App Settings overrides:
 *   ATLAS_DAILY_BUDGET_USD   per-instance daily $ ceiling (default 5.00)
 */

const DEFAULT_DAILY_BUDGET_USD = 5.0;

// Conservative USD per 1K *output* tokens. Costs are upper bounds so the
// cap kicks in before real spend matches the estimate. Update when the
// deployment changes.
const COST_PER_1K_OUTPUT: Record<string, number> = {
  'gpt-4o-mini': 0.0006,
  'gpt-4o': 0.015,
  'gpt-4.1-mini': 0.0016,
  'gpt-4.1-nano': 0.0004,
  'gpt-4.1': 0.008,
  'o4-mini': 0.0044,
};
const DEFAULT_COST_PER_1K = 0.015;

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
  const parsed = raw ? Number.parseFloat(raw) : DEFAULT_DAILY_BUDGET_USD;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_BUDGET_USD;
}

function ensureToday(): void {
  const today = todayKey();
  if (dailyBudget.date !== today) {
    dailyBudget = { date: today, costUsd: 0 };
  }
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
 * Record an estimated cost for a model call. Use a worst-case maxTokens
 * value rather than actual usage so the cap is conservative.
 */
export function recordEstimatedCost(deployment: string, maxTokens: number): void {
  ensureToday();
  const rate = COST_PER_1K_OUTPUT[deployment] ?? DEFAULT_COST_PER_1K;
  dailyBudget.costUsd += (maxTokens / 1000) * rate;
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
