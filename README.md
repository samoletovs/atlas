# atlas

atlas is a personal-teacher PWA that turns GitHub activity into short lessons
and tracks what it has already taught.

## Research question

atlas tests the NauroLabs question **"Where's the AI-human boundary?"** It asks
whether an AI teacher can derive useful, non-repetitive lessons from work a
person has already done while keeping the learner in control of sources,
feedback, and follow-up questions.

## What it does

- Connects a GitHub repository to a user's learning profile.
- Generates cited, phone-readable lessons from repository activity.
- Tracks topic coverage, reading progress, ratings, and review cards.
- Supports follow-up questions, sharing, quotas, and cached-lesson fallback.

## Learning experience

**Learn** combines the ready-lesson queue and personalized recommendations: one useful
next lesson, its relevance and source context, then other available lessons. Due review
items remain useful even when there is nothing new to read; queued content is clearly
separate from ready lessons.

**Topics** starts with a readable index, with the existing relationship graph available
as an optional view. **Saved** and **History** keep revisiting straightforward. A focused
reader retains source references, citations, contextual questions, feedback and next
suggestions without turning the home page into a chatbot or a deployment dashboard.

Confirmed saves and reads refresh the relevant repository's collections even when
the reader has already navigated away. Saving an unread lesson contributes topic
interest to recommendations without counting it as read. Generation entry points
share current quota state and provide recovery when account limits cannot refresh.

The Clear way design uses a yellow reading band, cool-neutral surfaces, comfortable
humanist typography and both light and dark themes. Reading depth means coverage, not
mastery; lesson publication does not imply that software was deployed. See
[PRODUCT.md](PRODUCT.md) for the product boundaries.

Recommendations use `GET /api/recommendations`, outside the parameterized
`/api/lessons/{id}` namespace. The previous `/api/lessons/recommended` URL remains
compatible through explicit dispatch, so cached clients cannot mistake it for a
lesson id. Both URLs retain the same authorization and recommendation response
contract; the PWA cache covers both. Lesson and recommendation requests prefer
fresh network responses so confirmed progress is not replaced by an older
snapshot. Previously cached responses remain available on network failure;
explicit HTTP errors are surfaced rather than replaced by cached success.
This fallback supports previously fetched content in an open session; account
verification and a fresh authenticated startup still require connectivity.
`npm run build && npm run test:pwa` checks the generated service worker in a
real browser against a local synthetic server, including offline fallback and
auth/account exclusions.

## Repository access

Repository IDs identify the GitHub owner and name (`owner__repository`), but the
Atlas owner is the user recorded on the repository document. Access and shared
repository discovery use that stored owner, including for organization and
third-party repositories. Malformed explicit IDs return 400 rather than silently
selecting a default repository. Ambiguous ownership records return 409 and require
operator resolution; the lookup does not provide transactional uniqueness across
Cosmos partitions.

## Stack

- React 19, TypeScript, Vite, and Playwright
- Azure Functions v4 and Cosmos DB
- Microsoft Foundry / Azure OpenAI
- Azure Static Web Apps with GitHub authentication
- Python lesson-generation tooling

## Run locally

```powershell
npm install
Copy-Item api\local.settings.json.example api\local.settings.json
Push-Location api
npm install
npm run build
Pop-Location
npm run dev
```

The local backend uses Azure Functions tooling. See [docs/HANDOFF.md](docs/HANDOFF.md)
for authentication and service setup.

## Test instructions

Before submitting a change (install Chromium once with `npm run test:install`):

```powershell
npm test --prefix api
npm run build --prefix api
npm run test:typecheck
npm run build
npm test
```

The API tests exercise the lesson handler with synthetic model responses and mocked
storage, without credentials or network access. The root Playwright suite includes
production authentication smoke tests and local portal regressions.
`npm run test:typecheck` checks all root tests and the Playwright configuration with strict
TypeScript settings and Node 20 declarations, without emitting files. `npm test`
still runs the full suite and starts a local Vite app by default.

Run only the local portal, adaptive-scoring, related-topic, and read-notification
regressions with:

```powershell
npm run test:portal
```

The portal regressions use mocked API responses, not a real account or model.
CI runs these regressions, test type checking, API tests/build, and the frontend
build before uploading anything to Static Web Apps. After a production deployment,
a separate job runs only `smoke.spec.ts` against the deployed site's authentication
boundary, without repeating the local regressions.

`ATLAS_LOCAL_BASE_URL` can target an explicitly started local app for portal tests.
`ATLAS_BASE_URL` continues to select the deployment used by the production smoke tests.
For a production-only smoke run, set `ATLAS_SMOKE_ONLY=1` and run
`npx playwright test smoke.spec.ts` to avoid starting Vite. The flag only disables
the local server; it does not filter tests. CI sets it only on the postdeployment
smoke step. Leave it unset for `npm test` or `npm run test:portal`.

## Status

**MVP / multi-user beta.** GitHub onboarding, lesson generation, follow-up
questions, feedback, quotas, and spaced review are implemented. Bring-your-own
model credentials and public lesson discovery remain roadmap items.

## License

MIT
