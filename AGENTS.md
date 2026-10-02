# atlas — Agent Guidance

## Project type

Personal-teacher app + agent. Single user (Sam) for now. Watches GitHub activity, generates phone-readable lessons via Microsoft Foundry agent, surfaces them in a PWA.

## Stack

- **Frontend:** React 19 + Vite 8 + TypeScript, deployed to Azure Static Web Apps
- **Backend:** Azure Functions v4 (Node 20, TypeScript)
- **Database:** Cosmos DB (NoSQL) — containers: `lessons`, `topics`, `activity_events`
- **Models:** prepared selective pilot on `foundrylab-aiservices`: routine API
  `gpt-6-luna`, explicitly deep lessons `gpt-6-sol` (both v2026-09-22).
  Classic scheduled agents stay on `gpt-4o-mini` until separately verified.
- **Auth:** GitHub OAuth via Static Web Apps built-in auth. Identity =
  GitHub handle; user docs are partitioned by `userId = login.toLowerCase()`.
  See [`docs/AUTH-GOOGLE.md`](docs/AUTH-GOOGLE.md) for the (deprecated)
  Google path; production uses GitHub.
- **Lesson generation script:** Python 3.11, uses `azure-ai-agents` + `azure-cosmos` SDK
- **IaC:** Bicep
- **Region:** `swedencentral` (parallels foundryLab)

## Coding standards

- TypeScript strict mode
- Frontend uses native CSS (no Tailwind for now)
- Backend functions return JSON; errors as `{error: string}` with proper HTTP status
- Cosmos partition: `userId` (single user "sam" for MVP)
- DefaultAzureCredential everywhere; never API keys
- All API endpoints expect SWA `x-ms-client-principal` header for auth

## Files NOT to commit

- `.env` (Azure outputs)
- `.env.local`, `.env.development`
- `node_modules/`, `dist/`, `.vite/`
- `coverage/`, `.azure/`, `.swa/`
- `infrastructure/outputs.json`
- `scripts/__pycache__/`, `*.pyc`

## Cost discipline

- Cosmos DB: serverless mode, RU/s capped
- Foundry agent reuses foundryLab account → no new AOAI cost
- SWA: Free tier (no custom domain initially)
- Azure budget alert: €5/month threshold

The model refresh is **not promoted**. The parent owns the combined +$10/month
pilot and API/quality gates. Deep API lessons use Sol with low reasoning and a
4,096 completion-token cap; other lessons use Luna/1,024 and ask-more Luna/600.
The existing daily per-instance budget is not a durable global monthly cap.
Reserve uncached input and full completion cost before calling the model; never
assume cache hits or guess a price for an unknown alias.
See [README.md](README.md#model-pilot) for shadowing settings, rollback,
persistent classic agents and the separate triage auth blocker.

## Skills to invoke when working here

- `microsoft-foundry` — for any agent / model / vector store changes
- `azure-identity-py` — for credential setup
- `azure-cosmos-db-py` — for backend Cosmos work
- `webapp-testing` — for frontend smoke tests
- `nauro-ops` — when checking lab-wide cost impact

## Common operations

```powershell
# Deploy infra (idempotent)
.\infrastructure\deploy.ps1

# Generate fresh batch of lessons
.\.venv\Scripts\python.exe scripts\generate_lessons.py

# Generate seed lessons (one-time, foundryLab activity)
.\.venv\Scripts\python.exe scripts\generate_lessons.py --seed

# Run frontend locally
npm run dev

# Run backend locally
cd api && npm start

# Deploy frontend + backend to SWA
swa deploy ./dist --api-location ./api --env production
```
