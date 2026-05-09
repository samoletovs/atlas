/**
 * Cosmos client + helpers — one container client per request.
 *
 * Auth:
 *   - Local dev: DefaultAzureCredential picks up your `az login`
 *   - SWA-hosted Functions: managed identity (Azure AI User on Cosmos)
 */
import { CosmosClient, Container, FeedOptions } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';

const endpoint = process.env.COSMOS_ENDPOINT;
const databaseName = process.env.COSMOS_DATABASE ?? 'atlas';

if (!endpoint) {
  throw new Error('COSMOS_ENDPOINT is not set');
}

let _client: CosmosClient | null = null;

export function cosmosClient(): CosmosClient {
  if (!_client) {
    _client = new CosmosClient({
      endpoint: endpoint!,
      aadCredentials: new DefaultAzureCredential(),
    });
  }
  return _client;
}

export function lessonsContainer(): Container {
  return cosmosClient().database(databaseName).container('lessons');
}

export function topicsContainer(): Container {
  return cosmosClient().database(databaseName).container('topics');
}

export const ATLAS_USER_ID = process.env.ATLAS_USER_ID ?? 'sam';

export type LessonStatus = 'queued' | 'drafting' | 'published' | 'read' | 'archived';

export interface Lesson {
  id: string;
  userId: string;
  title: string;
  topic: string;
  depth: 'intro' | 'intermediate' | 'deep';
  read_minutes: number;
  body: string;
  citations: string[];
  suggested_next: { title: string; topic: string; rationale: string }[];
  source_event?: { type: string; ref: string; summary: string } | null;
  status: LessonStatus;
  created_at: string;
  read_at?: string | null;
  saved?: boolean;
}
