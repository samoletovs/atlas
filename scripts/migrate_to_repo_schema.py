"""
atlas — One-shot migration from single-tenant `lessons` schema to the multi-repo
schema introduced in P1 of MULTI-USER-PLAN.md.

Reads every doc in the existing `lessons` container (partitioned by /userId)
and writes:

  * `lessons_v2`     — same content, partitioned by /repoId, with ownerId set,
                       `status='read'` collapsed to `published` (read state is
                       per-reader and moves to `lessonProgress`).
  * `lessonProgress` — one doc per (userId, lessonId) for any source doc with
                       status='read' or saved=true.
  * `repos`          — one doc per (ownerId, repoId).
  * `users`          — one doc per ownerId.

The original `lessons` container is left untouched as a backup. Drop it manually
once you've verified everything reads correctly from the new shape.

Defaults: targets the production Cosmos account from atlas/.env. Migrates the
existing 'sam' library to ownerId='samoletovs', repoId='samoletovs__nauroLabs'.
The canonical separator is '__' (double underscore) because Cosmos document IDs
cannot contain '/'. Pretty URL form (`/r/owner/repo/...`) is reconstructed at the
route layer.

Usage::

    # Dry run — print what would happen, write nothing
    python scripts/migrate_to_repo_schema.py

    # Apply
    python scripts/migrate_to_repo_schema.py --apply

    # Migrate a custom owner/repo (rare — only if you ran with a different ATLAS_USER_ID)
    python scripts/migrate_to_repo_schema.py --apply --owner-login samoletovs \\
        --repo-id samoletovs__nauroLabs --github-url https://github.com/samoletovs/nauroLabs-github
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from azure.cosmos import CosmosClient, exceptions
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv

# --- Paths / env ------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
ATLAS_DIR = SCRIPT_DIR.parent
load_dotenv(ATLAS_DIR / ".env")

COSMOS_ENDPOINT = os.environ["COSMOS_ENDPOINT"]
COSMOS_DATABASE = os.environ.get("COSMOS_DATABASE", "atlas")
ATLAS_USER_ID = os.environ.get("ATLAS_USER_ID", "sam")

# --- Logging ----------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)
for noisy in ("azure.core.pipeline.policies.http_logging_policy", "azure.identity"):
    logging.getLogger(noisy).setLevel(logging.WARNING)
log = logging.getLogger("migrate")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def lesson_v2_from_v1(doc: dict, *, owner_id: str, repo_id: str) -> dict:
    """Project a v1 lesson doc onto the v2 shape.

    v2 drops per-user state (status='read', read_at, saved) — that moves to
    `lessonProgress`. v1 'read' becomes v2 'published'.
    """
    src_status = doc.get("status", "published")
    new_status = "published" if src_status == "read" else src_status

    out: dict[str, Any] = {
        "id": doc["id"],
        "repoId": repo_id,
        "ownerId": owner_id,
        "title": doc.get("title", ""),
        "topic": doc.get("topic", ""),
        "depth": doc.get("depth", "intro"),
        "read_minutes": doc.get("read_minutes", 4),
        "body": doc.get("body", ""),
        "citations": doc.get("citations", []),
        "suggested_next": doc.get("suggested_next", []),
        "source_event": doc.get("source_event"),
        "status": new_status,
        "language": doc.get("language", "en"),
        "created_at": doc.get("created_at", now_iso()),
    }
    if "body_original" in doc:
        out["body_original"] = doc["body_original"]
    return out


def progress_from_v1(doc: dict, *, user_id: str, repo_id: str) -> dict | None:
    """Return a lessonProgress doc if the v1 record carries reader state."""
    is_read = doc.get("status") == "read" or bool(doc.get("read_at"))
    is_saved = bool(doc.get("saved"))
    if not is_read and not is_saved:
        return None
    return {
        "id": f"{user_id}_{doc['id']}",
        "userId": user_id,
        "repoId": repo_id,
        "lessonId": doc["id"],
        "status": "read" if is_read else "unread",
        "readAt": doc.get("read_at"),
        "saved": is_saved or None,
    }


def upsert(container, doc: dict, *, dry_run: bool) -> None:
    if dry_run:
        log.info("  [dry-run] upsert %s id=%s", container.id, doc["id"])
        return
    container.upsert_item(doc)


def ensure_repo(container, *, owner_id: str, repo_id: str, github_url: str, dry_run: bool) -> None:
    # Display name = the part after the separator. Supports either '__' (canonical)
    # or '/' (legacy plan form) just in case someone passes the latter.
    if "__" in repo_id:
        name = repo_id.split("__", 1)[-1]
    elif "/" in repo_id:
        name = repo_id.split("/", 1)[-1]
    else:
        name = repo_id
    doc = {
        "id": repo_id,
        "repoId": repo_id,
        "ownerId": owner_id,
        "name": name,
        "githubUrl": github_url,
        "visibility": "private",
        "createdAt": now_iso(),
    }
    try:
        existing = container.read_item(item=repo_id, partition_key=owner_id)
        log.info("  repo exists: %s (visibility=%s)", repo_id, existing.get("visibility"))
        return
    except exceptions.CosmosResourceNotFoundError:
        pass
    log.info("  creating repos doc: %s", repo_id)
    upsert(container, doc, dry_run=dry_run)


def ensure_user(container, *, github_login: str, dry_run: bool) -> None:
    doc = {
        "id": github_login,
        "userId": github_login,
        "githubLogin": github_login,
        "createdAt": now_iso(),
    }
    try:
        existing = container.read_item(item=github_login, partition_key=github_login)
        log.info("  user exists: %s", existing["userId"])
        return
    except exceptions.CosmosResourceNotFoundError:
        pass
    log.info("  creating users doc: %s", github_login)
    upsert(container, doc, dry_run=dry_run)


def main() -> int:
    p = argparse.ArgumentParser(description="atlas multi-repo schema migration")
    p.add_argument("--apply", action="store_true", help="Actually write to Cosmos. Default is dry-run.")
    p.add_argument(
        "--source-user-id",
        default=ATLAS_USER_ID,
        help=f"Partition key in the v1 `lessons` container. Default: {ATLAS_USER_ID!r}",
    )
    p.add_argument("--owner-login", default="samoletovs", help="GitHub login of the owner. Default: samoletovs")
    p.add_argument(
        "--repo-id",
        default="samoletovs__nauroLabs",
        help="Repo identifier in the new schema. Cosmos forbids '/' in document IDs, so we use '__'. Default: samoletovs__nauroLabs",
    )
    p.add_argument(
        "--github-url",
        default="https://github.com/samoletovs/nauroLabs-github",
        help="GitHub URL of the source repo.",
    )
    args = p.parse_args()

    dry_run = not args.apply
    mode = "APPLY" if args.apply else "DRY-RUN"
    log.info("Migration mode: %s", mode)
    log.info("  source userId : %s", args.source_user_id)
    log.info("  ownerId       : %s", args.owner_login)
    log.info("  repoId        : %s", args.repo_id)
    log.info("  github url    : %s", args.github_url)
    log.info("  cosmos        : %s/%s", COSMOS_ENDPOINT, COSMOS_DATABASE)

    cosmos = CosmosClient(COSMOS_ENDPOINT, credential=DefaultAzureCredential())
    db = cosmos.get_database_client(COSMOS_DATABASE)

    # New containers must already exist (provisioned by Bicep). If any are missing,
    # the user hasn't deployed the updated infrastructure yet.
    required = ["lessons", "lessons_v2", "lessonProgress", "repos", "users"]
    existing = {c["id"] for c in db.list_containers()}
    missing = [name for name in required if name not in existing]
    if missing:
        log.error(
            "Containers missing from Cosmos: %s. Run atlas/infrastructure/deploy.ps1 first.",
            ", ".join(missing),
        )
        return 2

    src = db.get_container_client("lessons")
    dst_lessons = db.get_container_client("lessons_v2")
    dst_progress = db.get_container_client("lessonProgress")
    dst_repos = db.get_container_client("repos")
    dst_users = db.get_container_client("users")

    log.info("Ensuring users + repos rows...")
    ensure_user(dst_users, github_login=args.owner_login, dry_run=dry_run)
    ensure_repo(
        dst_repos,
        owner_id=args.owner_login,
        repo_id=args.repo_id,
        github_url=args.github_url,
        dry_run=dry_run,
    )

    log.info("Reading v1 lessons (userId=%s)...", args.source_user_id)
    v1_docs = list(
        src.query_items(
            query="SELECT * FROM c WHERE c.userId = @uid",
            parameters=[{"name": "@uid", "value": args.source_user_id}],
            partition_key=args.source_user_id,
        )
    )
    log.info("  found %d source lessons", len(v1_docs))

    migrated = 0
    skipped_existing = 0
    progress_written = 0

    for doc in v1_docs:
        lesson_id = doc["id"]
        # Idempotency: skip if already in lessons_v2.
        try:
            dst_lessons.read_item(item=lesson_id, partition_key=args.repo_id)
            skipped_existing += 1
            log.debug("  skip existing: %s", lesson_id)
            continue
        except exceptions.CosmosResourceNotFoundError:
            pass

        v2 = lesson_v2_from_v1(doc, owner_id=args.owner_login, repo_id=args.repo_id)
        log.info(
            "  migrate %s [%s] %s",
            lesson_id,
            v2["language"],
            v2.get("topic", "?"),
        )
        upsert(dst_lessons, v2, dry_run=dry_run)
        migrated += 1

        prog = progress_from_v1(doc, user_id=args.owner_login, repo_id=args.repo_id)
        if prog is not None:
            log.info("    + progress %s status=%s", prog["id"], prog["status"])
            upsert(dst_progress, prog, dry_run=dry_run)
            progress_written += 1

    log.info("---")
    log.info("Source lessons:    %d", len(v1_docs))
    log.info("Migrated to v2:    %d", migrated)
    log.info("Skipped (existed): %d", skipped_existing)
    log.info("Progress rows:     %d", progress_written)
    if dry_run:
        log.info("Dry run complete. Re-run with --apply to write.")
    else:
        log.info("Migration complete. Old `lessons` container left as backup.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
