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
USER_ID = os.environ.get("ATLAS_USER_ID", "sam")  # legacy v1 schema (seed/enhance modes)
OWNER_LOGIN = os.environ.get("ATLAS_OWNER_LOGIN", "samoletovs")  # v2 schema (pending mode)

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

Markdown formatting (use these to make scanning the lesson on a phone effortless):

10. **Bold** every defined term on first use, plus 1–2 phrases per lesson that capture
    the central insight. Do not over-bold — fewer than ~6 bolded fragments per lesson.
11. Use exactly ONE callout per major section (max 3 per lesson) with this syntax:
       > [!KEY] One-line title (optional)
       > One or two short sentences with the central takeaway for that section.
    Available kinds: KEY (the big idea), TIP (practical advice), WARN (common pitfall),
    REMEMBER (worth memorizing). Pick the one that fits — don't use all four.
12. Cross-link 3–7 specific concepts to other lessons using the syntax
    [term](topic:slug-here). Use lowercase, hyphenated slugs that match how a topic
    would be named (e.g. [managed identity](topic:managed-identity),
    [retrieval augmented generation](topic:rag)). Only link genuinely useful
    follow-ups, not every noun. The reader can click the link to either jump
    to an existing lesson or generate one on demand.
13. Use bulleted or numbered lists for enumerable trade-offs, steps, or comparisons —
    they read much better than commas-in-a-paragraph on mobile.

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


# Used by --enhance to retrofit existing lessons with the new formatting.
ENHANCER_INSTRUCTIONS = """You are atlas-enhancer — a careful editor that retrofits existing lessons
with a richer markdown format. Do NOT rewrite the lesson. Do NOT change facts, examples,
or the author's voice. Apply ONLY the markdown enhancements listed below.

Enhancements to apply:

A. **Bold** every defined term on first use, plus 1–2 phrases per lesson that capture
   the central insight. Aim for 4–6 bolded fragments. If the lesson is already bolded,
   keep what's there and don't add more.

B. Add 1–3 callouts where they help scanning. Use exactly this syntax — a blockquote
   that begins with [!KIND]:
       > [!KEY] One-line title (optional)
       > One or two short sentences capturing the section's takeaway.

   Available kinds: KEY (the big idea), TIP (practical advice), WARN (common pitfall),
   REMEMBER (worth memorizing). Pick the one that fits each callout — variety is good
   but don't force more than 3 total.

C. **MANDATORY:** Cross-link AT LEAST 3 specific terms to other lessons using
   [term](topic:slug-here). Use lowercase, hyphenated slugs. Prefer slugs from
   this list of EXISTING topics (so the link resolves to a real lesson):

%KNOWN_TOPICS%

   You may also use slugs that aren't in the list — those will become "generate on
   demand" pills, which is fine. Pick terms that genuinely point to a different
   concept worth its own lesson, not every noun.

   Example transformation:
     before: "Use managed identity instead of API keys for Azure services."
     after:  "Use [managed identity](topic:azure/identity/managed-identity) instead of API keys for Azure services."

   If you produce ZERO topic: links the lesson is incomplete.

D. If the body has none, you MAY add one short bulleted list (3–5 items) where a
   paragraph is currently a long sentence enumerating trade-offs. Do not add lists
   elsewhere.

Hard rules:
- Preserve the body's overall length (±15%) and section structure.
- Preserve every existing URL and citation.
- Do NOT change headings, lists that already exist, code blocks, or facts.
- Do NOT touch the title, topic, depth, read_minutes, citations, or suggested_next.
- Match the lesson's language: if it's in Russian, write the new bold terms,
  callout text, and link labels in Russian (slugs stay English).

Input: a JSON object with the existing lesson body and metadata.
Output: a single JSON object with EXACTLY this shape:

{
  "body": "the enhanced markdown body"
}

Output ONLY the JSON. No prose. No markdown fences. Plain JSON.
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


def get_or_create_enhancer_agent(client: AgentsClient, known_topics: list[str]) -> str:
    """Return agent_id for atlas-enhancer; bake the known-topics list into instructions.

    Recreates the agent each run so instruction changes always take effect — the
    Foundry update path can be sticky.
    """
    name = "atlas-enhancer"
    instructions = ENHANCER_INSTRUCTIONS.replace(
        "%KNOWN_TOPICS%",
        "\n".join(f"   - {t}" for t in sorted(set(known_topics))) or "   (none yet)",
    )
    for agent in client.list_agents():
        if agent.name == name:
            log.info("Removing stale agent %s (%s) for fresh recreate", name, agent.id)
            try:
                client.delete_agent(agent.id)
            except Exception as exc:  # noqa: BLE001
                log.warning("  could not delete: %s", exc)
    log.info("Creating agent %s", name)
    agent = client.create_agent(
        model=FOUNDRY_DEPLOYMENT,
        name=name,
        instructions=instructions,
        temperature=0.2,
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


def fetch_all_lessons(cosmos: CosmosClient) -> list[dict[str, Any]]:
    """Return all non-archived lessons for the current user."""
    container = cosmos.get_database_client(COSMOS_DATABASE).get_container_client("lessons")
    items = container.query_items(
        query=(
            "SELECT * FROM c "
            "WHERE c.userId = @uid AND (NOT IS_DEFINED(c.status) OR c.status != 'archived') "
            "ORDER BY c.created_at ASC"
        ),
        parameters=[{"name": "@uid", "value": USER_ID}],
        enable_cross_partition_query=False,
        partition_key=USER_ID,
    )
    return list(items)


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:50]


def known_topic_slugs(lessons: list[dict[str, Any]]) -> list[str]:
    """Build the list of slug-shaped strings the enhancer can confidently link to.

    Includes: each lesson's `topic` (already slug-shaped) plus a slug derived
    from the title for human-readable variants.
    """
    slugs: set[str] = set()
    for doc in lessons:
        topic = doc.get("topic")
        if topic:
            slugs.add(topic)
        title = doc.get("title")
        if title:
            slugs.add(slugify(title))
    return sorted(slugs)


def already_enhanced(body: str) -> bool:
    """Heuristic: a lesson is 'already enhanced' if it has any callouts or topic links."""
    if not body:
        return False
    if re.search(r"^>\s*\[!", body, flags=re.MULTILINE):
        return True
    if re.search(r"\]\(topic:", body):
        return True
    return False


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
    """Return all queued lessons in `lessons_v2` owned by OWNER_LOGIN.

    The v2 schema partitions by `/repoId` and identifies the owner via
    `ownerId` (GitHub login). One owner can have many repos, so we run a
    cross-partition query scoped to the owner.
    """
    container = cosmos.get_database_client(COSMOS_DATABASE).get_container_client("lessons_v2")
    items = container.query_items(
        query=(
            "SELECT * FROM c WHERE c.ownerId = @owner AND c.status = 'queued' "
            "ORDER BY c.created_at ASC"
        ),
        parameters=[{"name": "@owner", "value": OWNER_LOGIN}],
        enable_cross_partition_query=True,
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
    container = cosmos.get_database_client(COSMOS_DATABASE).get_container_client("lessons_v2")

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

        # v2 partitions by /repoId — the SDK derives it from body["repoId"].
        container.replace_item(item=doc["id"], body=doc)
        generated += 1
        log.info("    -> published '%s' [%s] (%d words)", doc["title"], lang, len(doc["body"].split()))

    log.info("Done. Drained %d queued lesson(s).", generated)
    return 0


# --- Enhance mode (backfill existing lessons with bold/callouts/links) ------

def enhance_lesson_body(
    client: AgentsClient,
    agent_id: str,
    doc: dict[str, Any],
    source_body: str,
    extra_hint: str | None = None,
) -> str:
    """Run the enhancer agent on a single lesson; return the enhanced body.

    `source_body` is what gets fed to the model — usually the live body, but
    body_original on a forced re-enhance.
    `extra_hint` is an optional additional instruction appended to the user prompt
    (used for the retry path when the first call ignored cross-links).
    """
    payload = {
        "title": doc.get("title", ""),
        "topic": doc.get("topic", ""),
        "language": doc.get("language", "en"),
        "depth": doc.get("depth", "intro"),
        "body": source_body,
    }
    user_prompt = json.dumps(payload, ensure_ascii=False, indent=2)
    if extra_hint:
        user_prompt = f"{user_prompt}\n\nADDITIONAL INSTRUCTION: {extra_hint}"

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
        result = json.loads(text)
        if "body" not in result or not isinstance(result["body"], str):
            raise RuntimeError("Enhancer returned no 'body' field")
        return result["body"]
    finally:
        client.threads.delete(thread.id)


def _count_topic_links(body: str) -> int:
    return len(re.findall(r"\]\(topic:", body))


def run_enhance(force: bool = False, dry_run: bool = False, limit: int | None = None) -> int:
    """Backfill existing lessons with bold/callouts/wiki-links.

    Args:
        force:    re-enhance even lessons that already have callouts or topic links.
        dry_run:  log what would change but don't write to Cosmos.
        limit:    process at most N lessons (handy for trial runs).
    """
    cosmos = get_cosmos_client()
    lessons = fetch_all_lessons(cosmos)
    log.info("Mode: ENHANCE — %d lesson(s) on file", len(lessons))

    todo: list[dict[str, Any]] = []
    for doc in lessons:
        if doc.get("status") == "queued":
            log.info("  SKIP %s [%s] (queued — body not generated yet)",
                     doc.get("topic"), doc.get("language", "en"))
            continue
        if not force and already_enhanced(doc.get("body", "")):
            log.info("  SKIP %s [%s] (already enhanced)",
                     doc.get("topic"), doc.get("language", "en"))
            continue
        todo.append(doc)

    if limit is not None:
        todo = todo[:limit]

    log.info("Will process %d lesson(s)%s", len(todo), " (dry run)" if dry_run else "")
    if not todo:
        return 0

    if dry_run:
        for doc in todo:
            log.info("  WOULD ENHANCE %s [%s] '%s'",
                     doc.get("topic"), doc.get("language", "en"), doc.get("title"))
        return 0

    agents = make_agents_client()
    known = known_topic_slugs(lessons)
    log.info("Cross-link vocabulary: %d known slug(s)", len(known))
    agent_id = get_or_create_enhancer_agent(agents, known)
    container = cosmos.get_database_client(COSMOS_DATABASE).get_container_client("lessons")

    enhanced = 0
    failed = 0
    for i, doc in enumerate(todo):
        topic = doc.get("topic", "")
        lang = doc.get("language", "en")
        log.info("  ENH  %s [%s] '%s'", topic, lang, doc.get("title"))
        if i > 0:
            time.sleep(8)  # gentle on TPM

        # Source: prefer body_original (preserved from very first enhance) so
        # repeated --force runs don't compound bolding/links.
        source_body = doc.get("body_original") or doc.get("body", "")
        old_len = len(doc.get("body", ""))

        try:
            new_body = enhance_lesson_body(agents, agent_id, doc, source_body)
        except Exception as exc:  # noqa: BLE001
            log.error("  FAIL %s [%s]: %s", topic, lang, exc)
            failed += 1
            continue

        # Post-validate: if zero topic: links, retry once with a hard nudge.
        if _count_topic_links(new_body) == 0:
            log.warning("  retry %s [%s]: 0 topic-links produced, asking again", topic, lang)
            time.sleep(4)
            try:
                new_body = enhance_lesson_body(
                    agents, agent_id, doc, source_body,
                    extra_hint=(
                        "Your previous output had ZERO topic: links. This is unacceptable. "
                        "You MUST insert at least 3 [term](topic:slug) cross-links inline. "
                        "Pick concrete nouns from the body — a tool, a service, a concept — "
                        "and turn them into links to a related lesson. Return ONLY the JSON {\"body\": \"...\"}."
                    ),
                )
            except Exception as exc:  # noqa: BLE001
                log.error("  FAIL retry %s [%s]: %s", topic, lang, exc)
                failed += 1
                continue
            if _count_topic_links(new_body) == 0:
                log.warning("  WARN %s [%s]: still 0 cross-links after retry, accepting anyway", topic, lang)

        new_len = len(new_body)
        if new_len < len(source_body) * 0.5:
            log.warning(
                "  SKIP %s [%s]: enhancer returned suspiciously short body (%d -> %d chars), keeping original",
                topic, lang, old_len, new_len,
            )
            failed += 1
            continue

        # First time we enhance, snapshot the original.
        if "body_original" not in doc:
            doc["body_original"] = doc.get("body", "")

        doc["body"] = new_body
        doc["enhanced_at"] = datetime.now(timezone.utc).isoformat()
        container.replace_item(item=doc["id"], body=doc)
        enhanced += 1
        log.info("    -> enhanced (%d -> %d chars, %d topic-links)",
                 old_len, new_len, _count_topic_links(new_body))

    log.info("Done. Enhanced %d / %d lesson(s) (failed: %d).", enhanced, len(todo), failed)
    return 0 if failed == 0 else 2


# --- Auto mode (per-repo autonomous generation, P4) -------------------------
#
# For each `repos` doc where `autoGenerate = true`, if the interval has
# elapsed since the last run, count unread published lessons for the owner
# and — if below `unreadTarget` — propose `(unreadTarget - unread)` new
# lessons from recent commit activity. Queued docs land in `lessons_v2`
# with empty body; the same run then drains them via `run_pending()`.
#
# Reads:
#   - cosmos `repos` (cross-partition WHERE autoGenerate = true)
#   - cosmos `lessons_v2` (per-repoId, count published + non-archived)
#   - cosmos `lessonProgress` (per-userId, count read)
#   - GitHub commits API (anonymous, or PAT from ATLAS_GH_TOKEN env)
# Writes:
#   - cosmos `lessons_v2` (insert queued stubs)
#   - cosmos `repos` (update lastRunAt + lastSeenCommitSha)

ATLAS_GH_TOKEN = os.environ.get("ATLAS_GH_TOKEN", "")

AUTO_GEN_DEFAULTS_INTERVAL = 24
AUTO_GEN_DEFAULTS_UNREAD_TARGET = 20
# Cap per-run regardless of unreadTarget, so a misconfigured repo can't
# explode token spend.
AUTO_GEN_MAX_PER_RUN = 10

PLANNER_INSTRUCTIONS = """You are atlas-planner — you propose lesson topics for a working consultant
who is pivoting from D365 functional work toward Azure / agentic solutions. You are given a
code repository the consultant is building (or shares with collaborators), the most recent
commit messages on the default branch, and a list of topics already covered as lessons in
their atlas library. Propose N new lesson topics that would help this consultant.

Rules:
1. Each proposal must be a standalone lesson, not a continuation of an existing one.
2. Pick angles that explain the WHY behind a change, not the exact code lines. A commit
   like "wire DefaultAzureCredential" should yield a lesson on **managed identity**, not
   one on python syntax.
3. Avoid duplicates. Skip any topic that is already on the "existing topics" list, even
   approximately (e.g. if "managed-identity" exists, do not propose "managed-identity-overview").
4. Keep topic slugs specific and kebab-case. "azure-auth" is too broad. Prefer
   "managed-identity-vs-service-principal" or "cosmos-partition-key-design".
5. Vary depth thoughtfully: "intro" for new ground for this repo, "intermediate" for
   areas already represented at intro depth, "deep" only if the consultant has at least
   3 intro-level lessons on the same area.
6. Each rationale must be one short sentence that says why THIS reader, given the recent
   commits, should care today.

Output a single JSON object with EXACTLY this shape:

{
  "items": [
    {
      "title": "Short descriptive title (max 60 chars)",
      "topic": "kebab-case-slug",
      "depth": "intro|intermediate|deep",
      "rationale": "1-sentence why this matters now",
      "source_sha": "<commit sha you tied this to, or empty>",
      "source_summary": "<one-line commit message or 'repo overview'>"
    }
  ]
}

Output exactly N items in the `items` array. No prose around the JSON. No markdown fences.
"""


def _get_or_create_planner_agent(client: AgentsClient) -> str:
    """Return the agent_id for atlas-planner. Recreates on each run to keep instructions fresh."""
    name = "atlas-planner"
    for agent in client.list_agents():
        if agent.name == name:
            try:
                client.update_agent(
                    agent_id=agent.id,
                    model=FOUNDRY_DEPLOYMENT,
                    instructions=PLANNER_INSTRUCTIONS,
                    temperature=0.5,
                )
                log.info("Reusing planner agent %s", agent.id)
                return agent.id
            except Exception:  # noqa: BLE001
                try:
                    client.delete_agent(agent.id)
                except Exception:  # noqa: BLE001
                    pass
                break
    log.info("Creating atlas-planner agent")
    agent = client.create_agent(
        model=FOUNDRY_DEPLOYMENT,
        name=name,
        instructions=PLANNER_INSTRUCTIONS,
        temperature=0.5,
    )
    return agent.id


def _fetch_auto_repos(cosmos: CosmosClient) -> list[dict[str, Any]]:
    """Return all repos with autoGenerate = true, cross-partition."""
    container = cosmos.get_database_client(COSMOS_DATABASE).get_container_client("repos")
    items = container.query_items(
        query="SELECT * FROM c WHERE c.autoGenerate = true",
        enable_cross_partition_query=True,
    )
    return list(items)


def _count_unread_for_owner(
    cosmos: CosmosClient,
    repo_id: str,
    owner_id: str,
    language: str,
) -> int:
    """Count `published` lessons in this repo+language that the owner has NOT read."""
    db = cosmos.get_database_client(COSMOS_DATABASE)

    lessons = db.get_container_client("lessons_v2")
    pub_query = lessons.query_items(
        query=(
            "SELECT VALUE c.id FROM c "
            "WHERE c.repoId = @rid AND c.language = @lang AND c.status = 'published'"
        ),
        parameters=[
            {"name": "@rid", "value": repo_id},
            {"name": "@lang", "value": language},
        ],
        partition_key=repo_id,
    )
    published_ids = set(pub_query)
    if not published_ids:
        return 0

    progress = db.get_container_client("lessonProgress")
    read_query = progress.query_items(
        query=(
            "SELECT VALUE c.lessonId FROM c "
            "WHERE c.userId = @uid AND c.repoId = @rid AND c.status = 'read'"
        ),
        parameters=[
            {"name": "@uid", "value": owner_id},
            {"name": "@rid", "value": repo_id},
        ],
        partition_key=owner_id,
    )
    read_ids = set(read_query)
    return len(published_ids - read_ids)


def _existing_topic_slugs(
    cosmos: CosmosClient,
    repo_id: str,
    language: str,
) -> list[str]:
    """Return distinct topic slugs already covered in this repo+language (any status)."""
    lessons = cosmos.get_database_client(COSMOS_DATABASE).get_container_client("lessons_v2")
    rows = lessons.query_items(
        query=(
            "SELECT DISTINCT VALUE c.topic FROM c "
            "WHERE c.repoId = @rid AND c.language = @lang AND c.status != 'archived'"
        ),
        parameters=[
            {"name": "@rid", "value": repo_id},
            {"name": "@lang", "value": language},
        ],
        partition_key=repo_id,
    )
    return sorted({slug for slug in rows if slug})


def _parse_github_repo_id(repo_id: str) -> tuple[str, str] | None:
    """`samoletovs__nauroLabs` → ('samoletovs', 'nauroLabs')."""
    parts = repo_id.split("__", 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return None
    return parts[0], parts[1]


def _github_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "atlas-naurolabs",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if ATLAS_GH_TOKEN:
        headers["Authorization"] = f"Bearer {ATLAS_GH_TOKEN}"
    return headers


def _fetch_recent_commits(
    owner: str,
    repo_name: str,
    since_sha: str | None,
    n: int = 20,
) -> list[dict[str, Any]]:
    """Fetch up to `n` recent commits on the default branch. Returns [] on error.

    If `since_sha` is provided, returns only commits that came AFTER it
    (newer than the last one we digested). We page from the head and stop
    when we hit `since_sha`.
    """
    import urllib.request
    import urllib.error

    url = f"https://api.github.com/repos/{owner}/{repo_name}/commits?per_page={n}"
    req = urllib.request.Request(url, headers=_github_headers())
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        log.warning("  GitHub commits %s/%s failed: HTTP %s", owner, repo_name, exc.code)
        return []
    except Exception as exc:  # noqa: BLE001
        log.warning("  GitHub commits %s/%s failed: %s", owner, repo_name, exc)
        return []
    if not isinstance(data, list):
        return []

    out: list[dict[str, Any]] = []
    for c in data:
        if not isinstance(c, dict):
            continue
        sha = c.get("sha") or ""
        if since_sha and sha == since_sha:
            break  # everything before this we've already seen
        commit = c.get("commit") or {}
        message = (commit.get("message") or "").strip().splitlines()[0][:200]
        author = (commit.get("author") or {}).get("name") or ""
        date = (commit.get("author") or {}).get("date") or ""
        out.append({"sha": sha, "message": message, "author": author, "date": date})
    return out


def _fetch_readme(owner: str, repo_name: str) -> str:
    """Fetch raw README markdown, capped to 6_000 chars. Returns '' on error."""
    import urllib.request
    import urllib.error

    url = f"https://api.github.com/repos/{owner}/{repo_name}/readme"
    headers = {**_github_headers(), "Accept": "application/vnd.github.raw"}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            text = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError:
        return ""
    except Exception:  # noqa: BLE001
        return ""
    return text[:6_000]


def _run_planner(
    client: AgentsClient,
    agent_id: str,
    repo_doc: dict[str, Any],
    commits: list[dict[str, Any]],
    readme_excerpt: str,
    existing_topics: list[str],
    needed: int,
    language: str,
) -> list[dict[str, Any]]:
    """Ask the planner to propose `needed` new lesson topics. Returns the items list."""
    repo_name = repo_doc.get("name") or repo_doc.get("repoId", "")
    payload = {
        "repo": {
            "id": repo_doc.get("repoId"),
            "name": repo_name,
            "githubUrl": repo_doc.get("githubUrl"),
        },
        "language": language,
        "needed": needed,
        "existing_topics": existing_topics,
        "recent_commits": commits,
        "readme_excerpt": readme_excerpt,
    }
    user_prompt = json.dumps(payload, ensure_ascii=False, indent=2)
    if language == "ru":
        user_prompt += (
            "\n\nIMPORTANT: Generate titles and rationale strings in Russian (Русский). "
            "Topic slugs stay in English."
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
            raise RuntimeError(f"Planner run failed: {getattr(run, 'last_error', None)}")
        msgs = list(
            client.messages.list(
                thread_id=thread.id,
                order=ListSortOrder.ASCENDING,
            ),
        )
        agent_msg = next(m for m in reversed(msgs) if m.role == MessageRole.AGENT)
        text = "\n".join(t.text.value for t in agent_msg.text_messages).strip()
        text = re.sub(r"^```(?:json)?\s*\n", "", text)
        text = re.sub(r"\n```\s*$", "", text)
        result = json.loads(text)
    finally:
        client.threads.delete(thread.id)

    items = result.get("items") if isinstance(result, dict) else None
    if not isinstance(items, list):
        return []

    cleaned: list[dict[str, Any]] = []
    seen_slugs = {s.lower() for s in existing_topics}
    for it in items:
        if not isinstance(it, dict):
            continue
        title = (it.get("title") or "").strip()
        topic = (it.get("topic") or "").strip().lower()
        depth = (it.get("depth") or "intro").strip().lower()
        if depth not in {"intro", "intermediate", "deep"}:
            depth = "intro"
        if not title or not topic:
            continue
        if topic in seen_slugs:
            continue
        seen_slugs.add(topic)
        cleaned.append({
            "title": title[:120],
            "topic": topic[:120],
            "depth": depth,
            "rationale": (it.get("rationale") or "").strip()[:400],
            "source_sha": (it.get("source_sha") or "").strip()[:40],
            "source_summary": (it.get("source_summary") or "").strip()[:200],
        })
    return cleaned[:needed]


def _slugify_for_id(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:50] or "lesson"


def _queue_lesson_stub(
    cosmos: CosmosClient,
    repo_doc: dict[str, Any],
    item: dict[str, Any],
    language: str,
) -> str:
    """Create a queued lesson stub in lessons_v2. Returns the new id."""
    container = cosmos.get_database_client(COSMOS_DATABASE).get_container_client("lessons_v2")
    repo_id = repo_doc["repoId"]
    owner_id = repo_doc["ownerId"]
    slug = _slugify_for_id(item["title"])
    suffix = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    lesson_id = f"lesson-{language}-{slug}-{suffix}"

    source_event: dict[str, Any] | None = None
    if item.get("source_sha") or item.get("source_summary"):
        source_event = {
            "type": "commit" if item.get("source_sha") else "repo-meta",
            "ref": item.get("source_sha") or repo_doc.get("githubUrl", ""),
            "summary": item.get("source_summary") or item.get("rationale", ""),
        }

    doc = {
        "id": lesson_id,
        "repoId": repo_id,
        "ownerId": owner_id,
        "title": item["title"],
        "topic": item["topic"],
        "depth": item["depth"],
        "read_minutes": 4,
        "body": "",
        "citations": [],
        "suggested_next": [],
        "source_event": source_event,
        "status": "queued",
        "language": language,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    container.create_item(body=doc)
    return lesson_id


def _update_repo_state(
    cosmos: CosmosClient,
    repo_doc: dict[str, Any],
    last_run_at: str,
    last_seen_commit_sha: str | None,
) -> None:
    """Patch lastRunAt + lastSeenCommitSha on the repo doc."""
    container = cosmos.get_database_client(COSMOS_DATABASE).get_container_client("repos")
    repo_doc["lastRunAt"] = last_run_at
    if last_seen_commit_sha:
        repo_doc["lastSeenCommitSha"] = last_seen_commit_sha
    container.replace_item(item=repo_doc["id"], body=repo_doc)


def _is_due(repo_doc: dict[str, Any], now_utc: datetime) -> bool:
    """True if the configured interval has elapsed since the last run."""
    last_run = repo_doc.get("lastRunAt")
    if not last_run:
        return True
    interval_hours = repo_doc.get("intervalHours", AUTO_GEN_DEFAULTS_INTERVAL)
    try:
        last = datetime.fromisoformat(str(last_run).replace("Z", "+00:00"))
    except ValueError:
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    elapsed_hours = (now_utc - last).total_seconds() / 3600.0
    # Subtract a small slack so a 4h cadence runs reliably on a 4h cron.
    return elapsed_hours >= (float(interval_hours) - 0.1)


def run_auto() -> int:
    """Plan + queue + drain for every opt-in repo.

    Always finishes by calling `run_pending()` so queued docs from this run
    (and any older stuck queue) get drained in the same workflow execution.
    """
    cosmos = get_cosmos_client()
    repos = _fetch_auto_repos(cosmos)
    log.info("Mode: AUTO — %d repo(s) with autoGenerate=true.", len(repos))

    now = datetime.now(timezone.utc)
    queued_this_run = 0
    planner_agent_id: str | None = None
    agents: AgentsClient | None = None

    for repo_doc in repos:
        repo_id = repo_doc.get("repoId") or repo_doc.get("id") or ""
        owner_id = repo_doc.get("ownerId") or ""
        if not repo_id or not owner_id:
            log.warning("  SKIP malformed repo doc id=%r", repo_doc.get("id"))
            continue

        if not _is_due(repo_doc, now):
            interval = repo_doc.get("intervalHours", AUTO_GEN_DEFAULTS_INTERVAL)
            log.info("  SKIP %s — not due yet (interval %sh, last run %s)",
                     repo_id, interval, repo_doc.get("lastRunAt"))
            continue

        unread_target = int(
            repo_doc.get("unreadTarget") or AUTO_GEN_DEFAULTS_UNREAD_TARGET,
        )
        unread_target = max(1, min(unread_target, 100))
        # Use English as the canonical language for unread budgeting — Russian
        # mirrors are bolt-ons, not gating signal.
        unread = _count_unread_for_owner(cosmos, repo_id, owner_id, "en")
        needed = unread_target - unread
        log.info("  CHECK %s — unread=%d target=%d needed=%d",
                 repo_id, unread, unread_target, needed)

        if needed <= 0:
            _update_repo_state(cosmos, repo_doc, now.isoformat(), None)
            continue

        # Cap so a misconfigured target can't blow the token budget.
        needed = min(needed, AUTO_GEN_MAX_PER_RUN)

        parsed = _parse_github_repo_id(repo_id)
        if not parsed:
            log.warning("  SKIP %s — could not parse owner/repo", repo_id)
            continue
        gh_owner, gh_repo = parsed

        commits = _fetch_recent_commits(
            gh_owner,
            gh_repo,
            since_sha=repo_doc.get("lastSeenCommitSha"),
            n=20,
        )
        readme = _fetch_readme(gh_owner, gh_repo) if not commits else ""
        if not commits and not readme:
            log.warning("  SKIP %s — no commits and no README (rate-limited or private?)", repo_id)
            _update_repo_state(cosmos, repo_doc, now.isoformat(), None)
            continue

        existing = _existing_topic_slugs(cosmos, repo_id, "en")
        log.info("  PLAN  %s — proposing %d topic(s) (have %d existing, %d commits)",
                 repo_id, needed, len(existing), len(commits))

        if agents is None:
            agents = make_agents_client()
        if planner_agent_id is None:
            planner_agent_id = _get_or_create_planner_agent(agents)

        try:
            proposals = _run_planner(
                agents,
                planner_agent_id,
                repo_doc,
                commits,
                readme,
                existing,
                needed,
                language="en",
            )
        except Exception as exc:  # noqa: BLE001
            log.error("  FAIL planner for %s: %s", repo_id, exc)
            continue

        if not proposals:
            log.info("  -> planner returned no usable proposals for %s", repo_id)
            _update_repo_state(cosmos, repo_doc, now.isoformat(), None)
            continue

        for p in proposals:
            try:
                lid = _queue_lesson_stub(cosmos, repo_doc, p, language="en")
                queued_this_run += 1
                log.info("    QUEUED %s [en] %s", p["topic"], p["title"])
                _ = lid  # for log clarity
            except Exception as exc:  # noqa: BLE001
                log.error("    FAIL queue %s: %s", p.get("topic"), exc)

        newest_sha = commits[0]["sha"] if commits else repo_doc.get("lastSeenCommitSha")
        _update_repo_state(cosmos, repo_doc, now.isoformat(), newest_sha)

    log.info("Planner phase done. Queued %d new lesson(s). Draining…", queued_this_run)
    # Always drain at the end so the same workflow run produces visible output.
    return run_pending()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", action="store_true", help="generate seed lessons")
    parser.add_argument("--pending", action="store_true",
                        help="drain queued lessons (status='queued') by generating their bodies")
    parser.add_argument("--auto", action="store_true",
                        help="run autonomous generation: for each opt-in repo whose interval has "
                             "elapsed, propose new topics from recent commits and queue+drain them. "
                             "Always drains existing queued lessons as well.")
    parser.add_argument("--enhance", action="store_true",
                        help="retrofit existing lessons with bold + callouts + wiki-links")
    parser.add_argument("--force", action="store_true",
                        help="(with --enhance) re-process even already-enhanced lessons")
    parser.add_argument("--dry-run", action="store_true",
                        help="(with --enhance) print what would change, don't write")
    parser.add_argument("--limit", type=int, default=None,
                        help="(with --enhance) process at most N lessons")
    parser.add_argument("--lang", nargs="+", default=["en", "ru"],
                        help="languages to generate for --seed (default: en ru)")
    args = parser.parse_args()
    if args.enhance:
        return run_enhance(force=args.force, dry_run=args.dry_run, limit=args.limit)
    if args.auto:
        return run_auto()
    if args.pending:
        return run_pending()
    if args.seed:
        run_seed(args.lang)
        return 0
    log.error("No mode selected. Use --seed, --pending, --auto, or --enhance.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
