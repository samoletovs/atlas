/**
 * GET /api/lessons?status=published|read|saved
 * Lists lessons for the current user, ordered by created_at desc.
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { lessonsContainer, ATLAS_USER_ID, Lesson } from '../shared/cosmos.js';
import { getPrincipal, isAuthorized } from '../shared/auth.js';

export async function listLessons(
  req: HttpRequest,
  ctx: InvocationContext
): Promise<HttpResponseInit> {
  const principal = getPrincipal(req);
  if (!isAuthorized(principal)) {
    return { status: 401, jsonBody: { error: 'Unauthorized' } };
  }

  const status = (req.query.get('status') ?? 'published') as Lesson['status'] | 'saved' | 'all';
  const lang = req.query.get('lang') ?? 'en';

  let query = '';
  if (status === 'all') {
    query = 'SELECT * FROM c WHERE c.userId = @uid AND (c.language = @lang OR NOT IS_DEFINED(c.language)) ORDER BY c.created_at DESC';
  } else if (status === 'saved') {
    query = 'SELECT * FROM c WHERE c.userId = @uid AND c.saved = true AND (c.language = @lang OR NOT IS_DEFINED(c.language)) ORDER BY c.created_at DESC';
  } else {
    query =
      'SELECT * FROM c WHERE c.userId = @uid AND c.status = @status AND (c.language = @lang OR NOT IS_DEFINED(c.language)) ORDER BY c.created_at DESC';
  }

  const container = lessonsContainer();
  const { resources } = await container.items
    .query<Lesson>({
      query,
      parameters: [
        { name: '@uid', value: ATLAS_USER_ID },
        { name: '@status', value: status },
        { name: '@lang', value: lang },
      ],
    }, { partitionKey: ATLAS_USER_ID })
    .fetchAll();

  ctx.log(`listLessons: ${resources.length} lessons (status=${status}, lang=${lang})`);
  return { status: 200, jsonBody: { lessons: resources } };
}

app.http('listLessons', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'lessons',
  handler: listLessons,
});
