# atlas — Agent Guidance

## Project type

Personal-teacher app + agent. Single user (Sam) for now. Watches GitHub activity, generates phone-readable lessons via Microsoft Foundry agent, surfaces them in a PWA.

## Stack

- **Frontend:** React 19 + Vite 8 + TypeScript, deployed to Azure Static Web Apps
- **Backend:** Azure Functions v4 (Node 20, TypeScript)
- **Database:** Cosmos DB (NoSQL) — containers: `lessons`, `topics`, `activity_events`
- **Agent:** Microsoft Foundry — reuses [foundryLab](../foundryLab/) account, model `gpt-4o-mini`, temperature 0.2
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
