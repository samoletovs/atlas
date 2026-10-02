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

## Model pilot

**Prepared, not promoted.** Parent synthetic API/quality approval and the
combined +$10/month pilot gate are prerequisites to deployment. Local tests
use synthetic lessons and mocked storage, not real user workloads.

All API model calls reuse `foundrylab-aiservices` (`foundrylab-rg`), with
same-named `gpt-6-luna` and `gpt-6-sol` deployments serving v2026-09-22.
Only `depth=deep` lesson requests select Sol; intro/intermediate lessons and
all follow-up chat stay routine. No model decides whether to escalate.

| SWA App Setting | Candidate value |
|---|---|
| `FOUNDRY_AOAI_ENDPOINT` | `https://foundrylab-aiservices.cognitiveservices.azure.com/` |
| `FOUNDRY_DEPLOYMENT` / `FOUNDRY_MODEL` | `gpt-6-luna` / `gpt-6-luna` |
| `FOUNDRY_LESSON_DEPLOYMENT` / `FOUNDRY_LESSON_MODEL` | `gpt-6-sol` / `gpt-6-sol` |
| `FOUNDRY_API_VERSION` | `2024-10-21` |
| `ATLAS_SOL_DAILY_BUDGET_USD` | `0.10` maximum; lower or `0` to disable |

Existing app settings shadow code defaults. Deployment and actual-model
settings must agree with the verified same-named deployment. Contradictory
pairs are rejected before client construction or premium-budget storage.
Arbitrary aliases are not admitted merely because a `*_MODEL` is supplied:
adding an alias requires a separately reviewed resource/deployment/model
mapping. No model detection or unknown-price fallback is performed.
Do not change the existing auth/SP secrets.

Luna requests use `reasoning_effort=none`, Sol `low`; completion ceilings are
1,024 routine lesson / 4,096 deep lesson / 600 follow-up tokens, including
reasoning. Refused or incomplete replies cannot be published. SDK retries are
disabled so one cost reservation covers one request. The existing
`ATLAS_DAILY_BUDGET_USD` value is retained (default $5 per warm instance/day);
the guard now reserves conservatively bounded **uncached input plus full
output** before inference and refuses an unaffordable request with HTTP 429.
The 24,000-byte conservative input-reservation ceiling applies to deep lessons,
not routine chat. Follow-up chat retains its existing 8-turn / 2,000-character
per-turn / 12,000-character total history, 6,000-character lesson excerpt and
1,000-character question limits. Valid multilingual input is not rejected
because its UTF-8 representation is longer. Input/configuration validation
finishes before an ask quota turn is consumed.
That general guard remains per-instance. **Sol additionally has a hard shared
$0.10/UTC-day admission limit**, including the uncapped-user allowlist.
`ATLAS_SOL_DAILY_BUDGET_USD` may lower or disable it; a value above $0.10 is
rejected. Selecting Sol as the routine model is also rejected.

Before inference, a reservation in the existing Cosmos `users` container
atomically creates or ETag-conditionally updates `sol-budget-YYYY-MM-DD` in
the dedicated `__atlas_sol_budget__` partition. Integer micro-USD reservations
cover conservatively bounded uncached input and the full output ceiling.
Workers, users and cold starts share the same row; a race rereads at most
three times. Missing storage, malformed state or uncertain writes fail closed
without calling the model. Failed requests are not refunded because their
remote cost may be unknown. Exhaustion returns HTTP 429, not a silent model
switch. No extra container, identity, or per-user profile field is introduced.

This bounds automated Sol admission to **$3.10 over 31 UTC days**, not the
whole Azure bill. Existing generation/ask quotas are unchanged. Parent still
owns aggregate cycle enforcement (USD80 ceiling / USD70 reserve within the
configured USD150 credit); Azure billing alerts do not stop model calls.

Global short-context USD/M prices: Luna **0.10 input / 0.50 output / 0.01
cached input**; Sol **2 / 10 / 0.20**. Reservations do not assume a cache hit.
Rollback sets both deployment/model pairs to `gpt-4o-mini` or `gpt-4.1`.
Legacy models receive `max_tokens` and temperature, without reasoning knobs.

### Scheduled agents are separate

[auto-generate.yml](.github/workflows/auto-generate.yml), job `generate`,
runs [generate_lessons.py](scripts/generate_lessons.py) against the classic
Foundry project endpoint. `FOUNDRY_AGENT_DEPLOYMENT` is deliberately pinned to
`gpt-4o-mini` by default and takes precedence over legacy `FOUNDRY_DEPLOYMENT`.
The existing persistent names are `atlas-teacher`, `atlas-planner` and
`atlas-enhancer`; teacher/planner are updated on reuse and enhancer recreated.
None was updated by this preparation.

Classic `azure-ai-agents` 1.1 create/run signatures have no declared
`reasoning_effort`; this script also lacks the API's daily dollar guard.
It therefore refuses GPT-6 before opening a client. **Do not promote all
three agents by changing the shared repository variable.** A separately
budgeted, synthetic classic-service gate is needed before that path can use
GPT-6. Keep `FOUNDRY_AGENT_DEPLOYMENT=gpt-4o-mini` (or `gpt-4.1` rollback).

Production API code ships through
[azure-static-web-apps.yml](.github/workflows/azure-static-web-apps.yml), job
**Build and Deploy Job**. Code publication does not update SWA app settings;
parent must apply the reviewed settings without wiping existing secrets.
The existing Bicep appsettings PUT replaces the collection, so do not blindly
redeploy with empty secret parameters.

### Issue triage

[copilot-triage.yml](.github/workflows/copilot-triage.yml), job `triage`,
defaults repository variable `TRIAGE_DEPLOYMENT` to Luna, cap 300 and
`reasoning_effort=none`. Rollback accepts only `gpt-4o-mini` or `gpt-4.1`
with legacy parameters; nano overrides are rejected. Incomplete/refused output requires human
review rather than assigning work.

The workflow still uses the existing endpoint and API-key secrets, not the
SWA credential or classic-agent identity. Parent reports Luna provisioned on
both accounts and the synthetic candidate gate passed (2026-10-02). The
workflow must still target the verified key-compatible account, not MI-only
foundryLab. Clear any retired nano `TRIAGE_DEPLOYMENT` variable or set Luna
before activation. No secret/auth change is included here.

## Status

**MVP / multi-user beta.** GitHub onboarding, lesson generation, follow-up
questions, feedback, quotas, and spaced review are implemented. Bring-your-own
model credentials and public lesson discovery remain roadmap items.

## License

MIT
