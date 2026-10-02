/**
 * Azure OpenAI client factory.
 *
 * Today: there's exactly one client, authenticated via SP credentials in App Settings
 * (`AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID`) against the foundryLab
 * Azure OpenAI endpoint. `getOpenAIClientForUser()` ignores its argument.
 *
 * P4 (BYOK): if `users.<userId>.byok` is set, decrypt the stored key and return a
 * per-user `AzureOpenAI` client pointed at their own endpoint + deployment. The
 * default branch stays as a fallback for users without BYOK configured.
 *
 * The public surface is `getOpenAIClientForUser(userId)` so call-sites are already
 * BYOK-shaped — flipping the feature on later doesn't change function signatures.
 */
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import { AzureOpenAI } from 'openai';

const AOAI_SCOPE = 'https://cognitiveservices.azure.com/.default';

let _defaultClient: AzureOpenAI | null = null;

const SUPPORTED_MODELS = ['gpt-6-luna', 'gpt-6-sol', 'gpt-4.1', 'gpt-4o-mini'] as const;
export type ActualModel = typeof SUPPORTED_MODELS[number];
export type ModelPurpose = 'routine' | 'deep-lesson';

export interface TextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function completionOptions(model: ActualModel, maxTokens: number, temperature: number):
  | { max_completion_tokens: number; reasoning_effort: 'none' | 'low' }
  | { max_tokens: number; temperature: number } {
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) {
    throw new Error('Invalid model completion ceiling');
  }
  if (model === 'gpt-6-luna' || model === 'gpt-6-sol') {
    return {
      max_completion_tokens: maxTokens,
      reasoning_effort: model === 'gpt-6-sol' ? 'low' : 'none',
    };
  }
  return { max_tokens: maxTokens, temperature };
}

export function estimateInputTokens(messages: readonly TextMessage[], purpose: ModelPurpose): number {
  // UTF-8 bytes plus message framing conservatively bound uncached text tokens.
  const tokens = messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, 'utf8') + 16, 0);
  if (purpose === 'deep-lesson' && tokens > 24_000) {
    throw new Error('Deep lesson input exceeds the 24000-token reservation limit');
  }
  return tokens;
}

function getDefaultClient(): AzureOpenAI {
  if (_defaultClient) return _defaultClient;
  const endpoint = process.env.FOUNDRY_AOAI_ENDPOINT;
  const apiVersion = process.env.FOUNDRY_API_VERSION ?? '2024-10-21';
  if (!endpoint) {
    throw new Error('FOUNDRY_AOAI_ENDPOINT must be set');
  }
  const credential = new DefaultAzureCredential();
  const azureADTokenProvider = getBearerTokenProvider(credential, AOAI_SCOPE);
  _defaultClient = new AzureOpenAI({
    endpoint,
    apiVersion,
    azureADTokenProvider,
    maxRetries: 0,
  });
  return _defaultClient;
}

export interface OpenAIClientForUser {
  client: AzureOpenAI;
  deployment: string;
  model: ActualModel;
  /** True when the call will be billed against the user's own subscription (BYOK). */
  isByok: boolean;
}

/**
 * Returns the AzureOpenAI client to use for a given user.
 *
 * P1: always returns the default (Sam's) client. The `userId` arg is taken but
 * ignored. The shape is fixed so call-sites are forward-compatible.
 *
 * P4 will look up `users.<userId>.byok` and, if present, return a client built
 * from the user's own endpoint/deployment/key.
 */
export async function getOpenAIClientForUser(
  _userId: string, purpose: ModelPurpose = 'routine',
): Promise<OpenAIClientForUser> {
  const prefix = purpose === 'deep-lesson' ? 'FOUNDRY_LESSON' : 'FOUNDRY';
  const deployment = (process.env[`${prefix}_DEPLOYMENT`] ??
    (purpose === 'deep-lesson' ? 'gpt-6-sol' : 'gpt-6-luna')).trim();
  const configuredModel = (process.env[`${prefix}_MODEL`] ?? deployment).trim();
  const model = SUPPORTED_MODELS.find(candidate => candidate === deployment);
  if (!model || configuredModel !== model) {
    throw new Error(`${prefix}_DEPLOYMENT and ${prefix}_MODEL must match a verified same-named model; unverified aliases are not allowed`);
  }
  if (purpose === 'routine' && model === 'gpt-6-sol') {
    throw new Error('Sol is restricted to explicitly deep lessons, not the routine deployment');
  }
  return {
    client: getDefaultClient(),
    deployment,
    model,
    isByok: false,
  };
}
