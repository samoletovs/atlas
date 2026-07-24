# atlas

> A personal teacher that turns your GitHub activity into bite-sized,
> phone-readable lessons — and remembers what it has already taught you.

**Status:** Multi-user beta — anyone with a GitHub account can sign in,
add a public-or-private repo, and start receiving lessons.
**Live:** [atlas.naurolabs.com](https://atlas.naurolabs.com)
**Lab:** [naurolabs.com](https://naurolabs.com)
**License:** MIT — see [LICENSE](LICENSE)

## What it does

1. **Sign in** with GitHub.
2. **Add a repo** — paste any GitHub URL. Public works out of the box;
   private repos require a personal access token stored encrypted in your
   atlas profile.
3. **Get lessons.** Atlas reads commits, READMEs, `AGENTS.md`, and
   `.github/reports/` from the repo and generates 300–900 word lessons
   tuned to fit on a phone screen.
4. **Read, ask, repeat.** Mark lessons as read, ask follow-up questions
   on any lesson, and atlas tracks topic coverage so you don't get the
   same idea twice.

Each user owns their atlas namespace per repo. Share read-only access by
GitHub handle, or keep everything private (default).

See [docs/VISION.md](docs/VISION.md) for the full product vision and
[docs/MULTI-USER-PLAN.md](docs/MULTI-USER-PLAN.md) for the roadmap.

## Try it (hosted)

The fastest path: just sign in at
[atlas.naurolabs.com](https://atlas.naurolabs.com) and add a repo.

There are **per-user daily caps** to keep the shared subscription
sustainable:

- **5 generated lessons per day** (`ATLAS_DAILY_GENERATION_CAP`)
- **30 ask-follow-up turns per day** (`ATLAS_DAILY_ASK_CAP`)

Plus a global **per-instance USD budget cap** as a hard ceiling
(`ATLAS_DAILY_BUDGET_USD`, default $5/day). When the budget is reached,
generation pauses until UTC midnight. See
[`api/src/shared/budget.ts`](api/src/shared/budget.ts) and
[`api/src/shared/quota.ts`](api/src/shared/quota.ts).

Bring-your-own-key (point atlas at your own Azure OpenAI deployment to
remove the cap) is on the roadmap — see
[docs/MULTI-USER-PLAN.md](docs/MULTI-USER-PLAN.md) P4.

## Run it yourself

```powershell
# 1. Provision Azure (one-time): Cosmos DB + SWA + Functions
.\infrastructure\deploy.ps1

# 2. Install + build
npm install
cd api; npm install; npm run build; cd ..

# 3. Run the frontend
npm run dev
```

Then open <http://localhost:5173>. The backend runs locally via SWA CLI;
see [`docs/HANDOFF.md`](docs/HANDOFF.md) for the full setup including
GitHub OAuth client registration.

## Project layout

```
atlas/
├── docs/                         # vision, roadmap, auth setup
├── infrastructure/               # Bicep IaC (Cosmos + SWA + Functions)
├── api/                          # Azure Functions v4 (Node 20 / TS)
│   ├── src/functions/            # HTTP endpoints (listLessons, addRepo, ...)
│   └── src/shared/               # auth, cosmos, quota, budget, openai client
├── src/                          # React 19 + Vite 8 PWA
│   ├── pages/                    # LessonsList, LessonReader, AddRepo, ...
│   └── lib/api.ts
├── scripts/                      # Python lesson-generator (Foundry agent)
├── tests/                        # Playwright smoke tests
└── staticwebapp.config.json      # routes, CSP, GitHub OAuth config
```

## Status

✅ Multi-user via GitHub OAuth
✅ Self-service repo onboarding (public + private with PAT)
✅ Share-by-handle read-only collaboration
✅ Daily per-user quota + global daily $ budget cap
✅ Lesson generator with citations, cross-links, markdown callouts
✅ Ask-more chat on any lesson (with cost-bounded history)
✅ English + Russian
✅ PWA + service worker for offline reading

⏳ Bring-your-own-key (lift per-user cap)
⏳ Public / unlisted lessons surface
✅ Spaced-repetition review cards

See [docs/MULTI-USER-PLAN.md](docs/MULTI-USER-PLAN.md) for the full phased plan.

## Contributing

PRs and issues welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

For security issues, please use the private disclosure channel described
in [SECURITY.md](SECURITY.md).

## Cost

Idle: well under €1/month (Cosmos serverless minimum + SWA Free).
Per generated lesson: ~$0.0005 on `gpt-4o-mini` (well within the daily $
cap above).

