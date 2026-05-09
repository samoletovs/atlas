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
        query="SELECT c.topic, c.depth FROM c WHERE c.userId = @uid",
        parameters=[{"name": "@uid", "value": USER_ID}],
        enable_cross_partition_query=False,
        partition_key=USER_ID,
    )
    return {f"{i['topic']}:{i['depth']}" for i in items}


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
            "Tools include file_search, code_interpreter, function calling, web. The reader "
            "is new to agents; emphasize that 'agent' is configuration, not code."
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
            "Default Foundry agent temperature is ~1.0 — chatty, stochastic, same question "
            "gives different answers on retries. Setting temperature=0.2 fixed it: same "
            "answer to same question, citation accuracy +9 percentage points. For grounded-fact "
            "agents (RAG, librarians, copilots over docs), 0.2 is the right default. Use "
            "0.7+ only for creative tasks. Why: temperature controls how randomly the model "
            "samples next tokens; low values pin it to its top guess, high values explore."
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
            "Northeurope ONLY offers GlobalProvisionedManaged SKU for Azure OpenAI on the "
            "Visual Studio Enterprise sub — that requires committing to monthly capacity, "
            "expensive even idle. Worse, no embedding models available. Sweden Central has the "
            "full consumption SKU range (Standard, GlobalStandard) AND text-embedding-3-large, "
            "DALL-E 3, realtime preview, all reasoning models. Sub-level region availability "
            "varies; always run `az cognitiveservices model list --location <region>` BEFORE "
            "committing in Bicep. Region matters more for AOAI workloads than for normal Azure."
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
            "Foundry: pro-developer, SDK + portal, pay-per-token, idle cost €0, built-in evals + "
            "RAG. Best for specialized API-consumed agents. Copilot Studio: low-code, business "
            "user-friendly, lives inside M365 (Teams, Outlook), per-message billing or seats. "
            "Custom Azure Functions + AOAI: total control, weird requirements, but you build "
            "everything yourself. Decision rule: M365-native conversational? → Copilot Studio. "
            "Specialized agent with evals/RAG? → Foundry. Special compliance/control? → custom. "
            "Common pattern: Copilot Studio front-end, Foundry agent as a tool for hard work."
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
            "GlobalStandard SKU = pay-per-token, no commitment. Capacity (e.g. 200K TPM) is a "
            "per-minute rate ceiling, NOT a monthly commitment. Provisioned SKUs reserve "
            "throughput — you pay even idle. Consumption (Standard, GlobalStandard) only bills "
            "tokens used. Implication for customer pilots: idle Foundry = €0/mo. Quote a capped "
            "per-query budget, not a fixed monthly fee. This reframes most POC conversations. "
            "Compare: M365 Copilot at €30/user/mo (seat-based) vs Foundry at €0.005 per query."
        ),
    },
]


# --- Main -------------------------------------------------------------------

def run_seed() -> None:
    log.info("Mode: SEED — generating %d day-1 lessons", len(SEED_BACKLOG))
    cosmos = get_cosmos_client()
    agents = make_agents_client()
    agent_id = get_or_create_atlas_agent(agents)
    log.info("Agent: %s", agent_id)

    existing = existing_lesson_topics(cosmos)
    log.info("Already covered: %d topic+depth pairs", len(existing))

    generated = 0
    for item in SEED_BACKLOG:
        key = f"{item['topic']}:{item['depth']}"
        if key in existing:
            log.info("  SKIP %s (already covered)", item["topic"])
            continue
        if generated > 0:
            time.sleep(8)  # gentle on TPM
        log.info("  GEN  %s", item["topic"])
        try:
            payload = generate_lesson(agents, agent_id, item)
        except Exception as exc:  # noqa: BLE001
            log.error("  FAIL %s: %s", item["topic"], exc)
            continue
        # Build a stable id slug
        slug = re.sub(r"[^a-z0-9]+", "-", payload["title"].lower()).strip("-")[:60]
        lesson = Lesson(
            id=f"lesson-{slug}",
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
        )
        upsert_lesson(cosmos, lesson)
        generated += 1
        log.info("    -> stored '%s' (%d words)", lesson.title, len(lesson.body.split()))

    log.info("Done. Generated %d new lesson(s).", generated)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", action="store_true", help="generate the 5 day-1 seed lessons")
    args = parser.parse_args()
    if args.seed:
        run_seed()
    else:
        log.error("Non-seed mode not yet implemented (Phase 4). Use --seed for now.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
