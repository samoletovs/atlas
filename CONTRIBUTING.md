# Contributing to atlas

Atlas is a research experiment from [NauroLabs](https://naurolabs.com).
Issues, ideas, and pull requests are welcome.

## Quick orientation

- **Frontend:** React 19 + Vite + TypeScript (in `src/`)
- **Backend:** Azure Functions v4, Node 20, TypeScript (in `api/`)
- **Database:** Cosmos DB (NoSQL), serverless
- **Model provider:** Azure OpenAI (`gpt-4o-mini`)
- **Auth:** GitHub OAuth via Azure Static Web Apps
- See `AGENTS.md` for full architectural notes and conventions.

## Bug reports

Open an issue with:

- What you tried to do
- What happened
- What you expected
- Browser / OS if it's a frontend bug; function name + roughly when if it's a backend bug

## Feature ideas

Open an issue with the **why** first (what problem are you trying to solve)
before suggesting **how**.

The atlas roadmap lives in [`docs/MULTI-USER-PLAN.md`](docs/MULTI-USER-PLAN.md).

## Pull requests

1. Fork, branch off `master`.
2. Keep PRs focused. One feature/fix per PR.
3. Follow the existing TypeScript style. The repo uses strict mode.
4. Add or update tests when touching `api/src/shared/` or anything cost-sensitive.
5. Run `npm run build` (root) and `cd api && npm run build` before submitting.
6. Describe the change in plain English in the PR body.

## What atlas accepts

- ✅ Bug fixes
- ✅ Documentation improvements
- ✅ Performance / cost improvements
- ✅ New lesson-quality features (formatting, callouts, cross-links)
- ✅ Accessibility improvements
- ✅ Localization beyond English / Russian

## What atlas does NOT accept

- ❌ Removing the per-user quota or daily budget cap (see `api/src/shared/quota.ts` and `budget.ts`)
- ❌ Hardcoded provider switches (atlas is multi-provider via `openaiClient.ts`)
- ❌ Breaking changes to `lessons_v2` Cosmos schema without a migration plan
- ❌ Anything that puts secrets in code or logs

## Security

See [`SECURITY.md`](SECURITY.md) for how to report security issues privately.

## Code of conduct

Be kind. Critique ideas, not people. See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
