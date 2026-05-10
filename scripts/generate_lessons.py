"""
atlas — Lesson generator

Generates phone-readable lessons (300–900 words) from activity events using
a Microsoft Foundry agent (reuses the foundryLab account). Writes lessons
directly to Cosmos DB.

Two modes:
  --seed     : generate the 5 day-1 seed lessons from foundryLab activity
  (default)  : generate next batch of lessons from current activity events

Usage:
    python scripts/generate_lessons.py --seed
    python scripts/generate_lessons.py
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from azure.ai.agents import AgentsClient
from azure.ai.agents.models import ListSortOrder, MessageRole
from azure.cosmos import CosmosClient, exceptions
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv

# --- Paths and env ----------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
ATLAS_DIR = SCRIPT_DIR.parent
load_dotenv(ATLAS_DIR / ".env")

COSMOS_ENDPOINT = os.environ["COSMOS_ENDPOINT"]
COSMOS_DATABASE = os.environ.get("COSMOS_DATABASE", "atlas")
FOUNDRY_PROJECT_ENDPOINT = os.environ["FOUNDRY_PROJECT_ENDPOINT"]
FOUNDRY_DEPLOYMENT = os.environ.get("FOUNDRY_DEPLOYMENT", "gpt-4o-mini")
USER_ID = os.environ.get("ATLAS_USER_ID", "sam")

# --- Logging ----------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
for noisy in ("azure.core.pipeline.policies.http_logging_policy", "azure.identity"):
    logging.getLogger(noisy).setLevel(logging.WARNING)
log = logging.getLogger("generate")


# --- Lesson data model ------------------------------------------------------
@dataclass
class Lesson:
    id: str
    title: str
    topic: str
    depth: str  # intro | intermediate | deep
    read_minutes: int
    body: str
    citations: list[str]
    suggested_next: list[dict[str, str]]  # [{title, topic, rationale}]
    source_event: dict[str, Any] | None
    created_at: str
    user_id: str
    language: str = "en"
    status: str = "published"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "topic": self.topic,
            "depth": self.depth,
            "read_minutes": self.read_minutes,
            "body": self.body,
            "citations": self.citations,
            "suggested_next": self.suggested_next,
            "source_event": self.source_event,
            "created_at": self.created_at,
            "userId": self.user_id,
            "language": self.language,
            "status": self.status,
        }


# --- Foundry agent ----------------------------------------------------------

LIBRARIAN_INSTRUCTIONS = """You are atlas — a personal teacher for a working consultant pivoting
from D365 functional work toward Azure / agentic solutions. Your job is to write phone-readable
lessons grounded in the user's actual build activity (commits, project docs) and authoritative
external knowledge.

Rules for every lesson you write:

1. Length: 300–900 words. Use the lower end for a single concept, higher for multi-concept.
2. Phone-friendly markdown. Short paragraphs (2–4 sentences). One main idea per paragraph.
3. Open with a 1-sentence hook that ties to user activity (or, for autonomous lessons, to a
   tech they use). Example: "When you bumped temperature to 0.2 yesterday, that one line
   doubled answer accuracy. Here's why."
4. Structure: Hook → Core concept → Trade-offs / when-it-applies → Why it matters in practice.
5. Use plain language. The reader is functional, not deep technical. Define jargon on first use.
6. Cite 1–3 authoritative sources at the end as plain URLs (Microsoft Learn preferred).
7. Avoid code blocks unless 3–6 lines maximum and absolutely necessary. Prefer prose.
8. Do NOT bury the lede. The "why this matters" should be in the first or second paragraph.
9. End every lesson with 2–3 "What to learn next" suggestions in JSON format the system can
   parse. Topics adjacent (sideways) or one level deeper.

You will be told the topic, depth, and source-event. Output a single JSON object with these
fields exactly:

{
  "title": "Short, descriptive title (max 60 chars)",
  "topic": "the topic slug provided",
  "depth": "intro|intermediate|deep",
  "read_minutes": <int 2..7>,
  "body": "the markdown body of the lesson",
  "citations": ["https://learn.microsoft.com/...", "..."],
  "suggested_next": [
    {"title": "...", "topic": "topic-slug", "rationale": "1-sentence why"},
    {"title": "...", "topic": "topic-slug", "rationale": "1-sentence why"}
  ]
}

Output ONLY the JSON. No prose around it. No markdown fences. Plain JSON.
"""


def make_agents_client() -> AgentsClient:
    return AgentsClient(
        endpoint=FOUNDRY_PROJECT_ENDPOINT,
        credential=DefaultAzureCredential(),
    )


def get_or_create_atlas_agent(client: AgentsClient) -> str:
    """Return the agent_id for the atlas-teacher agent. Create if not exists."""
    name = "atlas-teacher"
    for agent in client.list_agents():
        if agent.name == name:
            log.info("Found existing agent %s (%s)", name, agent.id)
            # Update instructions in case they evolved
            client.update_agent(
                agent_id=agent.id,
                model=FOUNDRY_DEPLOYMENT,
                instructions=LIBRARIAN_INSTRUCTIONS,
                temperature=0.4,  # slightly creative for lesson writing
            )
            return agent.id
    log.info("Creating agent %s", name)
    agent = client.create_agent(
        model=FOUNDRY_DEPLOYMENT,
        name=name,
        instructions=LIBRARIAN_INSTRUCTIONS,
        temperature=0.4,
    )
    return agent.id


def generate_lesson(
    client: AgentsClient,
    agent_id: str,
    backlog_item: dict[str, Any],
) -> dict[str, Any]:
    """Run the agent to generate a lesson body for one backlog item.

    Returns the parsed JSON object the agent produced.
    """
    user_prompt = json.dumps(
        {
            "topic": backlog_item["topic"],
            "depth": backlog_item["depth"],
            "title_hint": backlog_item.get("title"),
            "source_event": backlog_item.get("source_event"),
            "context_notes": backlog_item.get("context_notes", ""),
        },
        indent=2,
    )

    thread = client.threads.create()
    try:
        client.messages.create(
            thread_id=thread.id,
            role=MessageRole.USER,
            content=user_prompt,
        )
        run = client.runs.create_and_process(
            thread_id=thread.id,
            agent_id=agent_id,
        )
        if str(run.status) != "RunStatus.COMPLETED" and run.status != "completed":
            raise RuntimeError(f"Run failed: {getattr(run, 'last_error', None)}")

        msgs = list(
            client.messages.list(
                thread_id=thread.id,
                order=ListSortOrder.ASCENDING,
            ),
        )
        agent_msg = next(m for m in reversed(msgs) if m.role == MessageRole.AGENT)
        text = "\n".join(t.text.value for t in agent_msg.text_messages).strip()
        # Strip code-fences if model added them despite instructions
        text = re.sub(r"^```(?:json)?\s*\n", "", text)
        text = re.sub(r"\n```\s*$", "", text)
        return json.loads(text)
    finally:
        client.threads.delete(thread.id)


# --- Cosmos -----------------------------------------------------------------

def get_cosmos_client() -> CosmosClient:
    return CosmosClient(COSMOS_ENDPOINT, credential=DefaultAzureCredential())


def upsert_lesson(cosmos: CosmosClient, lesson: Lesson) -> None:
    container = cosmos.get_database_client(COSMOS_DATABASE).get_container_client("lessons")
    container.upsert_item(lesson.to_dict())


def existing_lesson_topics(cosmos: CosmosClient) -> set[str]:
    container = cosmos.get_database_client(COSMOS_DATABASE).get_container_client("lessons")
    items = container.query_items(
        query="SELECT c.topic, c.depth, c.language FROM c WHERE c.userId = @uid",
        parameters=[{"name": "@uid", "value": USER_ID}],
        enable_cross_partition_query=False,
        partition_key=USER_ID,
    )
    return {f"{i['topic']}:{i['depth']}:{i.get('language', 'en')}" for i in items}


# --- Seed lessons (foundryLab) ----------------------------------------------

SEED_BACKLOG: list[dict[str, Any]] = [
    {
        "topic": "agent-platforms/foundry/agent-anatomy",
        "depth": "intro",
        "title": "What an agent actually is",
        "source_event": {
            "type": "build",
            "ref": "samoletovs/foundryLab/labMemoryAgent",
            "summary": "Built first Foundry agent: lab-memory librarian over NauroLabs docs",
        },
        "context_notes": (
            "Foundry agent = (model + instructions + tools + memory). Six lines of Python "
            "create a working agent (model, name, instructions, tools, tool_resources, "
            "temperature). Threads hold conversation; runs execute the agent against a thread. "
            "Tools include file_search, code_interpreter, function calling, web."
        ),
    },
    {
        "topic": "agent-platforms/foundry/temperature",
        "depth": "intro",
        "title": "Why temperature 0.2 was the biggest quality lever",
        "source_event": {
            "type": "decision",
            "ref": "samoletovs/foundryLab/labMemoryAgent",
            "summary": "Set temperature=0.2 in provision.py; eliminated stochastic answers",
        },
        "context_notes": (
            "Default Foundry agent temperature is ~1.0 — chatty, stochastic. Setting "
            "temperature=0.2 fixed it: same answer to same question, citation accuracy +9pp."
        ),
    },
    {
        "topic": "azure/regions/aoai-availability",
        "depth": "intro",
        "title": "Why we picked Sweden Central over Northeurope",
        "source_event": {
            "type": "decision",
            "ref": "samoletovs/foundryLab/main.bicep",
            "summary": "Switched region from northeurope to swedencentral",
        },
        "context_notes": (
            "Northeurope ONLY offers GlobalProvisionedManaged SKU for Azure OpenAI — "
            "that requires committing to monthly capacity. Sweden Central has full "
            "consumption SKU range AND text-embedding-3-large, all reasoning models."
        ),
    },
    {
        "topic": "agent-platforms/comparison",
        "depth": "intro",
        "title": "Foundry vs Copilot Studio vs custom Azure",
        "source_event": {
            "type": "research",
            "ref": "samoletovs/foundryLab/docs/comparison.md",
            "summary": "Comparison matrix from foundryLab build",
        },
        "context_notes": (
            "Foundry: pro-developer, SDK + portal, pay-per-token, idle cost €0. "
            "Copilot Studio: low-code, M365-native, per-message billing. "
            "Custom Azure: total control but you build everything."
        ),
    },
    {
        "topic": "azure/cost/consumption-vs-provisioned",
        "depth": "intro",
        "title": "What 'idle Foundry costs €0' actually means",
        "source_event": {
            "type": "observation",
            "ref": "samoletovs/foundryLab/docs/pricing-notes.md",
            "summary": "Idle Foundry billing observation",
        },
        "context_notes": (
            "GlobalStandard SKU = pay-per-token, no commitment. Consumption only bills "
            "tokens used. Implication: idle Foundry = €0/mo."
        ),
    },
    # --- New topics from NauroLabs build activity ---
    {
        "topic": "azure/swa/authentication",
        "depth": "intro",
        "title": "SWA authentication: what's free and what costs €8/month",
        "source_event": {
            "type": "debugging",
            "ref": "samoletovs/atlas/staticwebapp.config.json",
            "summary": "Discovered Google auth requires Standard tier on new SWA gen .7",
        },
        "context_notes": (
            "SWA Free tier preconfigured providers: only Microsoft Entra ID and GitHub. "
            "Google was removed from newer SWA generations (.7+). Custom auth (Google, "
            "Apple, OIDC) requires Standard plan ~€8/month. Older SWAs (.1, .2) are "
            "grandfathered with Google. Always verify redirect chain ends at the right provider."
        ),
    },
    {
        "topic": "azure/swa/managed-functions",
        "depth": "intro",
        "title": "How SWA managed Functions work (and their limits)",
        "source_event": {
            "type": "build",
            "ref": "samoletovs/atlas/api",
            "summary": "Built atlas API as SWA managed Functions with Cosmos DB backend",
        },
        "context_notes": (
            "SWA managed Functions: put your code in /api folder, SWA deploys it automatically. "
            "No cold start for static, but Functions may cold-start. Free tier: no managed "
            "identity, no Key Vault references. App Settings only for secrets. ESM modules "
            "need module:'node16' in tsconfig for proper SWA compatibility."
        ),
    },
    {
        "topic": "web/react/component-patterns",
        "depth": "intro",
        "title": "React patterns that keep NauroLabs apps simple",
        "source_event": {
            "type": "observation",
            "ref": "samoletovs/golazo, rosette, tPlan, atlas",
            "summary": "Common patterns across 8 React apps in the lab",
        },
        "context_notes": (
            "useState+useEffect for data fetching (no library needed for simple apps). "
            "React.lazy + Suspense for code splitting. Context for theme/lang/auth state. "
            "NavLink for active-state navigation. CSS variables for theming instead of "
            "CSS-in-JS. Keep components < 100 lines. No Redux — useState is enough for "
            "single-user apps."
        ),
    },
    {
        "topic": "web/vite/build-optimization",
        "depth": "intro",
        "title": "Why your Vite bundle is 1.5MB and how to fix it",
        "source_event": {
            "type": "fix",
            "ref": "samoletovs/golazo, rosette, portaBaltica",
            "summary": "Bundle size optimization across 3 NauroLabs projects",
        },
        "context_notes": (
            "Default Vite config produces one giant chunk. Fix: add manualChunks in "
            "vite.config.ts to split react, charts (recharts/d3), i18n, PDF libs into "
            "separate chunks. Use React.lazy for routes not needed on first paint. "
            "golazo went from 1.1MB→824KB index, rosette from 770KB→207KB."
        ),
    },
    {
        "topic": "azure/cosmos/serverless-patterns",
        "depth": "intro",
        "title": "Cosmos DB serverless: the €0/month database for experiments",
        "source_event": {
            "type": "build",
            "ref": "samoletovs/atlas, golazo, era",
            "summary": "Three NauroLabs apps use Cosmos DB serverless",
        },
        "context_notes": (
            "Cosmos DB serverless: pay-per-request, no provisioned throughput, no idle cost. "
            "Partition key by userId. Session consistency (not strong — cheaper). "
            "Connection string auth on SWA Free (no MI available). Always use parameterized "
            "queries, never string concatenation. 7-day continuous backup by default."
        ),
    },
    {
        "topic": "devops/github-actions/swa-deploy",
        "depth": "intro",
        "title": "Ship to production with one git push",
        "source_event": {
            "type": "build",
            "ref": "samoletovs/atlas/.github/workflows/azure-static-web-apps.yml",
            "summary": "GitHub Actions CI/CD for atlas deploys on every push to main",
        },
        "context_notes": (
            "Azure/static-web-apps-deploy@v1 handles build + deploy in one step. "
            "app_location='/', api_location='api', output_location='dist'. "
            "SWA token stored as GitHub secret. Add Playwright smoke tests as a post-deploy "
            "step. Telegram notifications on success/failure."
        ),
    },
    {
        "topic": "azure/identity/managed-identity",
        "depth": "intro",
        "title": "DefaultAzureCredential: one line that replaces all API keys",
        "source_event": {
            "type": "pattern",
            "ref": "samoletovs/foundryLab, agentMode, atlas",
            "summary": "Managed Identity pattern used across NauroLabs Python + Node projects",
        },
        "context_notes": (
            "DefaultAzureCredential tries: environment vars → MI → az login → VS Code. "
            "Works in production (MI) and locally (az login). No API keys to rotate or leak. "
            "disableLocalAuth=true on Foundry account = keys blocked by construction. "
            "Cross-resource-group access via role assignment."
        ),
    },
    {
        "topic": "web/pwa/offline-first",
        "depth": "intro",
        "title": "Making a web app work offline with service workers",
        "source_event": {
            "type": "build",
            "ref": "samoletovs/atlas",
            "summary": "atlas is a PWA with offline reading via vite-plugin-pwa",
        },
        "context_notes": (
            "vite-plugin-pwa generates a service worker automatically. registerSW.js handles "
            "cache updates. manifest.webmanifest defines the installable app. Key lesson: "
            "service workers can intercept /.auth/* routes and break login — exclude auth "
            "paths from the SW's navigation fallback."
        ),
    },
    {
        "topic": "ai/prompt-engineering/structured-output",
        "depth": "intro",
        "title": "Getting JSON from an LLM without praying",
        "source_event": {
            "type": "pattern",
            "ref": "samoletovs/atlas/scripts/generate_lessons.py",
            "summary": "atlas lesson generator extracts structured JSON from GPT-4o-mini",
        },
        "context_notes": (
            "Tell the model 'Output ONLY the JSON. No prose. No markdown fences.' "
            "Still strip code fences anyway (regex: ^```json\\n and \\n```$). "
            "Use temperature 0.2-0.4 for structured output. Parse with json.loads, "
            "catch exceptions and retry once. Define the exact JSON schema in instructions."
        ),
    },
    {
        "topic": "azure/bicep/resource-naming",
        "depth": "intro",
        "title": "Bicep patterns that keep 11 projects consistent",
        "source_event": {
            "type": "pattern",
            "ref": "samoletovs/.github/infrastructure/modules",
            "summary": "Shared Bicep modules across NauroLabs",
        },
        "context_notes": (
            "targetScope='resourceGroup'. Resource naming: {flatcase}-{type} (atlas-swa, "
            "atlas-cosmos). Tags: {project, managedBy:'bicep', costCenter:'naurolabs-research'}. "
            "Shared modules: swa.bicep, monitoring.bicep. uniqueString for globally unique names. "
            "Region: northeurope default, swedencentral for AI workloads."
        ),
    },
    {
        "topic": "web/css/theming-with-variables",
        "depth": "intro",
        "title": "Dark and light mode with zero JavaScript (almost)",
        "source_event": {
            "type": "build",
            "ref": "samoletovs/atlas/src/styles.css",
            "summary": "atlas theme system using CSS custom properties",
        },
        "context_notes": (
            "Define colors as CSS custom properties in :root (dark) and [data-theme='light']. "
            "One line of JS sets the data-theme attribute. localStorage remembers the choice. "
            "prefers-color-scheme media query for OS default. No Tailwind needed for small apps. "
            "Keep the palette to ~10 variables: bg, bg-card, fg, fg-muted, accent, link, error."
        ),
    },
    {
        "topic": "security/api/input-validation",
        "depth": "intro",
        "title": "Every API boundary needs a gatekeeper",
        "source_event": {
            "type": "pattern",
            "ref": "samoletovs/era, rosette, atlas",
            "summary": "Input validation patterns across NauroLabs APIs",
        },
        "context_notes": (
            "zod (Node) or pydantic (Python) at every API boundary. Never trust req.body. "
            "SWA x-ms-client-principal header for auth — decode from base64, parse JSON. "
            "Parameterized Cosmos queries, never string concatenation. Error codes by "
            "category (VAL-*, BIZ-*, FIN-* in ERA). Return proper HTTP status codes."
        ),
    },
    {
        "topic": "career/d365-to-azure/learning-path",
        "depth": "intro",
        "title": "From D365 functional to Azure builder: what transfers and what doesn't",
        "source_event": {
            "type": "reflection",
            "ref": "samoletovs/naurolabs",
            "summary": "NauroLabs exists because a D365 consultant started building with AI",
        },
        "context_notes": (
            "What transfers: business process thinking, data modeling, integration patterns, "
            "understanding enterprise customers. What doesn't: frontend development (React), "
            "CI/CD, cloud infrastructure (Bicep/ARM), LLM prompt engineering. The gap is "
            "narrowing because AI copilots handle the syntax — you supply the 'why'."
        ),
    },
    {
        "topic": "ai/agents/multi-agent-coordination",
        "depth": "intermediate",
        "title": "Running 4 AI agents as a team: what we learned",
        "source_event": {
            "type": "observation",
            "ref": "samoletovs/.github/skills/nauro-run",
            "summary": "NauroLabs 4-agent system (plan, ops, build, run) manages the lab",
        },
        "context_notes": (
            "nauro-plan (strategy), nauro-ops (health), nauro-build (implementation), "
            "nauro-run (orchestrator). Agents can: scan trends, flag issues, patch deps. "
            "Agents can't: decide to ship revenue features (flagged 6x, never acted). "
            "Multi-agent = distributed systems problem: coordination, state, rollback."
        ),
    },
    {
        "topic": "azure/cost/budget-alerts",
        "depth": "intro",
        "title": "Azure budget alerts: €5/project keeps experiments alive",
        "source_event": {
            "type": "pattern",
            "ref": "samoletovs/.github/PLATFORM.md",
            "summary": "NauroLabs budget discipline for 11 research projects",
        },
        "context_notes": (
            "€5/month budget per resource group. 80% warning, 100% alert. Biggest spenders: "
            "PostgreSQL (turgo ~€15/mo), Container Apps. SWA Free = €0. Cosmos serverless = "
            "€0 idle. App Insights daily cap 0.1GB. Total lab spend ~€50/month on VS Enterprise "
            "credits. Cost discipline is what lets you run 11 experiments at once."
        ),
    },
]


# --- Main -------------------------------------------------------------------

def run_seed(languages: list[str] | None = None) -> None:
    if languages is None:
        languages = ["en"]
    log.info("Mode: SEED — generating %d topics × %d language(s)", len(SEED_BACKLOG), len(languages))
    cosmos = get_cosmos_client()
    agents = make_agents_client()
    agent_id = get_or_create_atlas_agent(agents)
    log.info("Agent: %s", agent_id)

    existing = existing_lesson_topics(cosmos)
    log.info("Already covered: %d topic+depth+lang triples", len(existing))

    generated = 0
    for lang in languages:
        for item in SEED_BACKLOG:
            key = f"{item['topic']}:{item['depth']}:{lang}"
            if key in existing:
                log.info("  SKIP %s [%s] (already covered)", item["topic"], lang)
                continue
            if generated > 0:
                time.sleep(8)  # gentle on TPM
            log.info("  GEN  %s [%s]", item["topic"], lang)

            # Inject language instruction into context
            lang_context = item.get("context_notes", "")
            if lang == "ru":
                lang_context = (
                    "IMPORTANT: Write the ENTIRE lesson in Russian (Русский). "
                    "Title, body, citations labels — everything in Russian. "
                    "Keep technical terms in English where natural (e.g. Azure, Cosmos DB, API). "
                    + lang_context
                )

            item_with_lang = {**item, "context_notes": lang_context}
            try:
                payload = generate_lesson(agents, agent_id, item_with_lang)
            except Exception as exc:  # noqa: BLE001
                log.error("  FAIL %s [%s]: %s", item["topic"], lang, exc)
                continue

            slug = re.sub(r"[^a-z0-9]+", "-", payload["title"].lower()).strip("-")[:50]
            lesson = Lesson(
                id=f"lesson-{lang}-{slug}",
                title=payload["title"],
                topic=payload["topic"],
                depth=payload["depth"],
                read_minutes=int(payload.get("read_minutes", 4)),
                body=payload["body"],
                citations=list(payload.get("citations", [])),
                suggested_next=list(payload.get("suggested_next", [])),
                source_event=item.get("source_event"),
                created_at=datetime.now(timezone.utc).isoformat(),
                user_id=USER_ID,
                language=lang,
            )
            upsert_lesson(cosmos, lesson)
            generated += 1
            log.info("    -> stored '%s' [%s] (%d words)", lesson.title, lang, len(lesson.body.split()))

    log.info("Done. Generated %d new lesson(s).", generated)


# --- Pending queue mode -----------------------------------------------------

def fetch_pending_lessons(cosmos: CosmosClient) -> list[dict[str, Any]]:
    """Return all lessons with status='queued' for the current user."""
    container = cosmos.get_database_client(COSMOS_DATABASE).get_container_client("lessons")
    items = container.query_items(
        query="SELECT * FROM c WHERE c.userId = @uid AND c.status = 'queued' ORDER BY c.created_at ASC",
        parameters=[{"name": "@uid", "value": USER_ID}],
        enable_cross_partition_query=False,
        partition_key=USER_ID,
    )
    return list(items)


def run_pending() -> int:
    """Drain queued lesson stubs by generating their bodies via the agent.

    Each queued lesson has title + topic + language but empty body. We feed
    those to the agent and replace the doc with a fully populated lesson.
    Idempotent — if the run is interrupted, queued stubs remain queued.
    """
    cosmos = get_cosmos_client()
    pending = fetch_pending_lessons(cosmos)
    if not pending:
        log.info("Mode: PENDING — no queued lessons.")
        return 0

    log.info("Mode: PENDING — draining %d queued lesson(s).", len(pending))
    agents = make_agents_client()
    agent_id = get_or_create_atlas_agent(agents)
    container = cosmos.get_database_client(COSMOS_DATABASE).get_container_client("lessons")

    generated = 0
    for i, doc in enumerate(pending):
        lang = doc.get("language", "en")
        title = doc.get("title", "")
        topic = doc.get("topic", "")
        depth = doc.get("depth", "intro")
        rationale = (doc.get("source_event") or {}).get("summary", "")

        log.info("  GEN  %s [%s] %s", topic, lang, title)
        if i > 0:
            time.sleep(8)  # gentle on TPM

        # Build context — explain that this was queued from another lesson's
        # "What to learn next" suggestion so the agent can write a focused piece.
        context_notes = (
            f"This lesson was queued from a 'What to learn next' suggestion. "
            f"Rationale provided: {rationale}. "
            f"Write a focused {depth}-level lesson on '{topic}'."
        )
        if lang == "ru":
            context_notes = (
                "IMPORTANT: Write the ENTIRE lesson in Russian (Русский). "
                "Title, body, citations labels — everything in Russian. "
                "Keep technical terms in English where natural (e.g. Azure, Cosmos DB, API). "
                + context_notes
            )

        backlog_item = {
            "topic": topic,
            "depth": depth,
            "title": title,
            "source_event": doc.get("source_event"),
            "context_notes": context_notes,
        }

        try:
            payload = generate_lesson(agents, agent_id, backlog_item)
        except Exception as exc:  # noqa: BLE001
            log.error("  FAIL %s [%s]: %s", topic, lang, exc)
            continue

        # Replace the queued doc in place — keeps the same id so any UI
        # referencing /lesson/<id> continues to work.
        doc["title"] = payload.get("title", title)
        doc["topic"] = payload.get("topic", topic)
        doc["depth"] = payload.get("depth", depth)
        doc["read_minutes"] = int(payload.get("read_minutes", 4))
        doc["body"] = payload.get("body", "")
        doc["citations"] = list(payload.get("citations", []))
        doc["suggested_next"] = list(payload.get("suggested_next", []))
        doc["status"] = "published"
        doc["language"] = lang
        # Keep created_at, but mark when the body landed
        doc["published_at"] = datetime.now(timezone.utc).isoformat()

        container.replace_item(item=doc["id"], body=doc)
        generated += 1
        log.info("    -> published '%s' [%s] (%d words)", doc["title"], lang, len(doc["body"].split()))

    log.info("Done. Drained %d queued lesson(s).", generated)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", action="store_true", help="generate seed lessons")
    parser.add_argument("--pending", action="store_true",
                        help="drain queued lessons (status='queued') by generating their bodies")
    parser.add_argument("--lang", nargs="+", default=["en", "ru"],
                        help="languages to generate for --seed (default: en ru)")
    args = parser.parse_args()
    if args.pending:
        return run_pending()
    if args.seed:
        run_seed(args.lang)
        return 0
    log.error("No mode selected. Use --seed or --pending.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
