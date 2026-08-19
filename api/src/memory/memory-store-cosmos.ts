/**
 * Azure Cosmos DB adapter for the shared memory core.
 *
 * CANONICAL COPY: `.github/config/memory/memory-store-cosmos.ts` (see PLATFORM.md §18).
 * For projects on Cosmos: atlas, era, golazo.
 *
 * Container requirements:
 *   - Partition key `/userId`. Memory is always read one user at a time, so this keeps
 *     every query single-partition - the difference between a point read and a fan-out
 *     that bills RU against every physical partition.
 *   - No custom indexing policy is needed: recall filters and ranks in memory, because
 *     a user's memory set is bounded by MAX_RECORDS_PER_USER and fits in one page.
 */

import type { Container } from '@azure/cosmos';
// The `.js` extension is required by projects on moduleResolution node16/nodenext
// (atlas, tPlan) and understood by those on bundler (era, golazo). Extensionless
// compiles in the second group and fails in the first, so this is the portable form.
import type { MemoryRecord, MemoryStore } from './memory-core.js';

export function createCosmosMemoryStore(container: Container): MemoryStore {
  return {
    async list(userId: string): Promise<MemoryRecord[]> {
      const { resources } = await container.items
        .query<MemoryRecord>({
          query: 'SELECT * FROM c WHERE c.userId = @userId',
          parameters: [{ name: '@userId', value: userId }],
        })
        // Explicit single-partition read. Without this the SDK may fan out.
        .fetchAll();
      return resources;
    },

    async put(record: MemoryRecord): Promise<void> {
      await container.items.upsert(record);
    },

    async delete(userId: string, id: string): Promise<void> {
      try {
        await container.item(id, userId).delete();
      } catch (error: unknown) {
        // Already absent is the desired end state; a "forget this" must be idempotent.
        if ((error as { code?: number })?.code !== 404) throw error;
      }
    },
  };
}
