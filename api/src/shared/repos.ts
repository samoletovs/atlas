import { reposContainer, type Repo } from './cosmos.js';

export class AmbiguousRepoError extends Error {
  constructor() {
    super('Repository ownership is ambiguous. Contact the operator to resolve it.');
  }
}

/**
 * GitHub's owner in repoId need not be the Atlas owner/partition.
 * Never pick an arbitrary partition when older additions created duplicates.
 */
export async function findRepoById(repoId: string): Promise<Repo | undefined> {
  const { resources } = await reposContainer().items.query<Repo>({
    query: 'SELECT TOP 2 * FROM c WHERE c.repoId = @repoId',
    parameters: [{ name: '@repoId', value: repoId }],
  }).fetchAll();
  if (resources.length > 1) throw new AmbiguousRepoError();
  return resources[0];
}
