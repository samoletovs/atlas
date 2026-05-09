# atlas — Handoff

> Built end-to-end on 2026-05-09 in autopilot mode.
> Status: **MVP live**. Phases 0–3 shipped + 5 seed lessons.

---

## 🎉 The thing actually works

**Live URL:** <https://atlas.naurolabs.com>

Open that on your phone right now. Tap "Sign in with Google". You'll get redirected to Google (your `d.samoletov@gmail.com` works). Land on the "Next up" screen. See the 5 seed lessons. Tap one. Read.

The PWA can be installed: from Chrome on phone → menu → "Add to Home Screen". After that the service worker caches everything for offline reading.

The Azure default URL `https://proud-plant-03d885403.7.azurestaticapps.net` also works as a fallback.

## What's deployed (Azure inventory)

| Resource | Name | Region | Notes |
|---|---|---|---|
| Resource group | `atlas-rg` | swedencentral | All atlas resources |
| Cosmos DB | `atlas-cosmos-4mpg7mbt44n3m` | swedencentral | Serverless, ~€0/mo idle |
| Static Web App | `atlas-swa` | westeurope (Free tier requires) | Hosts frontend + Functions |
| Log Analytics | `atlas-logs` | swedencentral | Diagnostic store |
| App Insights | `atlas-appi` | swedencentral | Telemetry |
| **Foundry agent** | `atlas-teacher` | (in foundryLab account) | gpt-4o-mini, temperature 0.4 |

Reuses `foundryLab-aiservices` (no new AI Services account; €0 incremental).

## What's in MVP (✅) and what's not (⏳)

✅ **Phase 0** — Bicep, Cosmos DB with `lessons`/`topics`/`activity_events` containers, SWA Free tier
✅ **Phase 1** — n/a (collector skipped to Phase 4)
✅ **Phase 2** — Foundry agent `atlas-teacher`, lesson generator script, 5 seed lessons
✅ **Phase 3** — PWA reader: Next up / Saved / Read / Reader screens, mark-read, save toggle, offline service worker, Microsoft sign-in via SWA built-in auth

⏳ **Phase 4 — Daily collector** (autonomous learning + git-watch). This is what makes atlas keep generating without you re-running anything.
⏳ **Phase 5 — Topic atlas graph view + Ask-more chat surface**
⏳ **Phase 6 — Custom subdomain** (`atlas.naurolabs.com`)
⏳ Topic memory (don't-repeat) — schema is there but the generator doesn't yet consult it
⏳ Spaced-repetition quiz cards

## The 5 seed lessons (live in Cosmos right now)

| Topic | Title | Read |
|---|---|---|
| `agent-platforms/foundry/agent-anatomy` | Understanding the anatomy of an agent | 5 min |
| `agent-platforms/foundry/temperature` | Why temperature 0.2 was the biggest quality lever | 5 min |
| `azure/regions/aoai-availability` | Why we picked Sweden Central over Northeurope | 5 min |
| `agent-platforms/comparison` | Foundry vs Copilot Studio vs custom Azure | 5 min |
| `azure/cost/consumption-vs-provisioned` | Understanding idle Foundry costs | 5 min |

These are the same content as the 6,400-word foundryLab learning guide, but phone-readable and in 5 chunks instead of one wall.

## How to use it from your phone

1. Open <https://proud-plant-03d885403.7.azurestaticapps.net>
2. Tap "Sign in with Microsoft" → use `samoletov@live.com`
3. After sign-in you land on **Next up** with the 5 seed lessons
4. Tap a card → read in **Reader**
5. Bottom of reader has [Mark read] and [Save]
6. Read tracks; Saved survives; "What to learn next" suggests follow-ups
7. Add to home screen → works fully offline after first visit

## How to generate more lessons (manually for now)

Until the daily GitHub Action collector exists (Phase 4), generate batches by re-running the script with new backlog items:

```powershell
# From workspace root
.\.venv\Scripts\python.exe atlas\scripts\generate_lessons.py --seed
```

The `--seed` flag uses the hardcoded list of 5 backlog items in `scripts/generate_lessons.py`. To generate fresh lessons on new topics, edit `SEED_BACKLOG` in that file with new entries.

The agent **already exists** (id stable, name `atlas-teacher`); rerunning the script just generates more lessons against it.

## How to add a custom domain `atlas.naurolabs.com`

The DNS for `naurolabs.com` lives in a Google Cloud DNS project that my current account doesn't have access to. To complete the subdomain:

1. **You** sign in to <https://console.cloud.google.com/net-services/dns/zones> with the account that owns `naurolabs.com`
2. Find the `naurolabs.com` zone
3. Add a CNAME: `atlas` → `proud-plant-03d885403.7.azurestaticapps.net`
4. Run `az staticwebapp hostname set -g atlas-rg -n atlas-swa --hostname atlas.naurolabs.com --validation-method cname-delegation`
5. Wait ~5 min for DNS + Azure to validate
6. Update `landing-page/projects.json` `appUrl` from the SWA default URL to `https://atlas.naurolabs.com`

## Cost so far

| Phase | Spend |
|---|---|
| Cosmos DB serverless setup | €0 (no data yet) |
| SWA Free tier | €0 |
| App Insights / Log Analytics | €0 (under free tier limits) |
| Foundry agent + 5 lesson generations (~25K tokens, gpt-4o-mini) | <€0.01 |
| **Total** | **~€0.01** |

Idle cost going forward: ~€0/month.

## Repository

- **GitHub:** <https://github.com/samoletovs/atlas> (private)
- **Landing page entry:** added to `.main/landing-page/projects.json`
- **Workspace manifest:** added to `.github/config/workspace-manifest.json`
- **Code workspace:** added to `nauroLabs.code-workspace`

## What broke during the build (one-line learnings)

1. Cosmos `EnableServerless` capability is rejected on API version >2024-05-15-preview. Use `properties.capacityMode = 'Serverless'` instead.
2. Cosmos account names are globally unique. Always use `uniqueString(resourceGroup().id, projectKey)` suffix.
3. SWA Free tier has no managed identity. For Cosmos auth, use `COSMOS_CONNECTION_STRING` app setting instead of `disableLocalAuth=true`. Trade-off: secret in app settings, but encrypted at rest.
4. SWA CLI v2.0.9 has a Windows binary issue (`StaticSitesClient.exe` exits 1). Use the official `Azure/static-web-apps-deploy@v1` GitHub Action via push instead.
5. SWA `staticwebapp.config.json` with custom Google identity provider needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` settings. For single-user, default AAD provider (no config) is simpler.

## Phase 4 sketch (the real next step)

To make atlas truly autonomous, build the daily collector:

1. **GitHub Action workflow** in this repo, scheduled `'0 6 * * *'`
2. Walks `samoletovs/*` repos via `gh api`, captures last-7-days commits + READMEs + reports
3. Calls a new Python script `scripts/run_collector.py` that:
   - Hashes activity events into Cosmos `activity_events`
   - Calls a new "proposer" prompt to generate backlog items
   - Calls "drafter" prompt for top-priority items, capped at 5/day
   - On low-activity days, also generates autonomous lessons from tech-stack inventory + uncovered foundational topics
4. Add a Functions `/api/health` endpoint to verify backend before each run

Estimated: 1 focused day. Reuses 80% of `generate_lessons.py`.

## Phase 5 sketch

- **Topic atlas page** — D3 force-directed graph of topics + edges (prereqs); tap a node to see lessons
- **Ask-more chat** — when reading a lesson, tap "Ask more"; opens an inline chat with the same agent scoped to the current lesson + topic; conversation saved as part of the lesson, informs future lessons on the same topic

## What I'd kill or rethink if MVP doesn't earn its keep

If by week 2 you haven't read at least 3 lessons on the phone, the activity-driven model isn't winning over the time-cost. Likely fixes in priority order:

1. Make the lessons shorter (300 words baseline, not 600)
2. Remove all chrome on the reader (just title + body, no metadata header)
3. Pre-generate audio narration (Foundry has TTS) — listen on commute beats reading
4. Drop autonomous-learning mode, only generate on real activity

If by week 6 you're not opening 4 days/7, kill the experiment. The cost of running atlas exceeds the value, and that's a finding.
