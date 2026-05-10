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

function getDefaultClient(): AzureOpenAI {
  if (_defaultClient) return _defaultClient;
  const endpoint = process.env.FOUNDRY_AOAI_ENDPOINT;
  const deployment = process.env.FOUNDRY_DEPLOYMENT;
  const apiVersion = process.env.FOUNDRY_API_VERSION ?? '2024-08-01-preview';
  if (!endpoint || !deployment) {
    throw new Error('FOUNDRY_AOAI_ENDPOINT and FOUNDRY_DEPLOYMENT must be set');
  }
  const credential = new DefaultAzureCredential();
  const azureADTokenProvider = getBearerTokenProvider(credential, AOAI_SCOPE);
  _defaultClient = new AzureOpenAI({
    endpoint,
    deployment,
    apiVersion,
    azureADTokenProvider,
  });
  return _defaultClient;
}

export interface OpenAIClientForUser {
  client: AzureOpenAI;
  deployment: string;
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
export async function getOpenAIClientForUser(_userId: string): Promise<OpenAIClientForUser> {
  return {
    client: getDefaultClient(),
    deployment: process.env.FOUNDRY_DEPLOYMENT!,
    isByok: false,
  };
}
