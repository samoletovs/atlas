# atlas

> A personal teacher that watches your AI-accelerated building and turns it into bite-sized, phone-readable lessons — never repeating itself.

**Status:** MVP — Phase 0–3 shipped 2026-05-09
**Domain:** `atlas.naurolabs.com` (TBD; Azure default URL works today)
**Subscription:** Visual Studio Enterprise, region `swedencentral`

## What it does

Watches your build activity on any GitHub repo you connect (commits, READMEs, AGENTS.md, `.github/reports/`), generates a prioritized backlog of foundational lessons (300–900 words, phone-readable), tracks what's been covered, and on quiet days proposes lessons autonomously from your tech stack and unfilled foundational areas.

See [docs/VISION.md](docs/VISION.md) for the full vision.

## Quickstart

```powershell
# 1. Provision Azure (one-time)
.\infrastructure\deploy.ps1

# 2. Generate the agent + initial lessons (one-time)
.\.venv\Scripts\python.exe scripts\generate_lessons.py --seed

# 3. Run the frontend locally
cd src
npm install
npm run dev
```

Then open <http://localhost:5173>.

## Project layout

```
atlas/
├── docs/
│   ├── VISION.md                 # full vision
│   └── HANDOFF.md                # what's built, what's next
├── infrastructure/
│   ├── main.bicep                # Cosmos DB + SWA + Functions + RBAC
│   ├── main.bicepparam
│   └── deploy.ps1                # idempotent deploy + .env writer
├── api/                          # Azure Functions (Node 20 / TS)
│   ├── src/
│   │   ├── functions/
│   │   │   ├── listLessons.ts
│   │   │   ├── getLesson.ts
│   │   │   ├── markRead.ts
│   │   │   └── askMore.ts
│   │   └── shared/
│   │       └── cosmos.ts
│   ├── package.json
│   └── tsconfig.json
├── src/                          # React + Vite PWA
│   ├── pages/
│   ├── components/
│   ├── App.tsx
│   ├── main.tsx
│   └── lib/api.ts
├── scripts/                      # Python lesson generator (uses foundryLab agent infra)
│   ├── generate_lessons.py
│   └── requirements.txt
├── package.json
├── tsconfig.json
├── vite.config.ts
├── staticwebapp.config.json
└── .gitignore
```

## What's in MVP and what's not

✅ Cosmos DB with `lessons` and `topics` containers
✅ Foundry agent generates 300–900 word lessons with citations
✅ PWA reader: Next up + Reader screens
✅ Mark-read updates topic memory
✅ Google OAuth via Static Web Apps
✅ 5 seed lessons from foundryLab activity
✅ Service worker for offline reading

⏳ Daily GitHub Action collector (Phase 4)
⏳ Topic atlas graph view (Phase 5)
⏳ Ask-more chat surface (Phase 5)
⏳ Autonomous-learning mode for quiet days (Phase 6)
⏳ Spaced-repetition quiz cards (Phase 6)
⏳ Custom subdomain (Phase 6 — needs Google Cloud DNS access)

See [docs/HANDOFF.md](docs/HANDOFF.md) for handoff details and next-step recipes.

## Cost

Idle: <€1/month (Cosmos DB minimum + SWA Free).
Active (lesson generation): ~€0.05–0.10 per generated lesson on `gpt-4o-mini`.
Reuses the [foundryLab](../foundryLab/) Foundry account — no additional AOAI cost.
