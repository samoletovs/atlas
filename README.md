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
- Supports follow-up questions, sharing, quotas, and offline PWA reading.

## Learning experience

**Learn** combines the ready-lesson queue and personalized recommendations: one useful
next lesson, its relevance and source context, then other available lessons. Due review
items remain useful even when there is nothing new to read; queued content is clearly
separate from ready lessons.

**Topics** starts with a readable index, with the existing relationship graph available
as an optional view. **Saved** and **History** keep revisiting straightforward. A focused
reader retains source references, citations, contextual questions, feedback and next
suggestions without turning the home page into a chatbot or a deployment dashboard.

The Clear way design uses a yellow reading band, cool-neutral surfaces, comfortable
humanist typography and both light and dark themes. Reading depth means coverage, not
mastery; lesson publication does not imply that software was deployed. See
[PRODUCT.md](PRODUCT.md) for the product boundaries.

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

Before submitting a change:

```powershell
npm test --prefix api
npm run build --prefix api
npm run build
npm test
```

The API tests exercise the lesson handler with synthetic model responses and mocked
storage, without credentials or network access. The root Playwright suite includes
production smoke tests and authenticated portal regressions. The portal regressions
use a local Vite app with mocked API responses, not a real account or model:

```powershell
npx playwright test tests\learningPortal.spec.ts --workers=2
```

`ATLAS_LOCAL_BASE_URL` can target an explicitly started local app for portal tests.
`ATLAS_BASE_URL` continues to select the deployment used by the production smoke tests.

## Status

**MVP / multi-user beta.** GitHub onboarding, lesson generation, follow-up
questions, feedback, quotas, and spaced review are implemented. Bring-your-own
model credentials and public lesson discovery remain roadmap items.

## License

MIT
