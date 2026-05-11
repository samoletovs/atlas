"""Repair already-published lessons that have empty `citations` or
`suggested_next` but a body containing the missing data inline.

Runs the same `_sanitize_lesson_payload` logic the generator now applies to
fresh teacher output. No LLM calls.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ATLAS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ATLAS_DIR / "scripts"))

from dotenv import load_dotenv

load_dotenv(ATLAS_DIR / ".env")

from azure.cosmos import CosmosClient  # noqa: E402
from azure.identity import AzureCliCredential  # noqa: E402

from generate_lessons import _sanitize_lesson_payload  # noqa: E402

COSMOS_ENDPOINT = os.environ["COSMOS_ENDPOINT"]
COSMOS_DATABASE = os.environ.get("COSMOS_DATABASE", "atlas")


def main() -> int:
    client = CosmosClient(COSMOS_ENDPOINT, credential=AzureCliCredential())
    db = client.get_database_client(COSMOS_DATABASE)
    container = db.get_container_client("lessons_v2")

    items = list(
        container.query_items(
            query=(
                "SELECT * FROM c WHERE c.status='published' AND "
                "(ARRAY_LENGTH(c.suggested_next) = 0 OR ARRAY_LENGTH(c.citations) = 0)"
            ),
            enable_cross_partition_query=True,
        )
    )
    print(f"Found {len(items)} lessons with possibly-broken structured fields.")

    repaired = 0
    for it in items:
        before_cit = len(it.get("citations") or [])
        before_sn = len(it.get("suggested_next") or [])
        before_body_len = len(it.get("body") or "")

        cleaned = _sanitize_lesson_payload(
            {
                "body": it.get("body") or "",
                "citations": it.get("citations") or [],
                "suggested_next": it.get("suggested_next") or [],
            }
        )

        after_cit = len(cleaned.get("citations") or [])
        after_sn = len(cleaned.get("suggested_next") or [])
        after_body_len = len(cleaned.get("body") or "")

        changed = (
            after_body_len != before_body_len
            or after_cit != before_cit
            or after_sn != before_sn
        )
        if not changed:
            continue

        it["body"] = cleaned["body"]
        it["citations"] = cleaned["citations"]
        it["suggested_next"] = cleaned["suggested_next"]

        container.replace_item(item=it["id"], body=it)
        repaired += 1
        print(
            f"  fixed {it['id']}  "
            f"cit:{before_cit}->{after_cit}  sn:{before_sn}->{after_sn}  "
            f"body:{before_body_len}->{after_body_len}"
        )

    print(f"Repaired {repaired} lesson(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
