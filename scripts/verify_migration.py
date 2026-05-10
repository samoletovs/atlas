"""One-off verification: count v2 lessons + repos + progress rows.

Run after `migrate_to_repo_schema.py --apply`.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv


def main() -> int:
    # silence Cosmos SDK's verbose HTTP logging
    logging.getLogger("azure").setLevel(logging.WARNING)

    repo_root = Path(__file__).resolve().parents[1]
    env_path = repo_root / ".env"
    if not env_path.exists():
        print(f"ERROR: {env_path} not found", file=sys.stderr)
        return 2
    load_dotenv(env_path)

    endpoint = os.environ.get("COSMOS_ENDPOINT")
    db_name = os.environ.get("COSMOS_DATABASE", "atlas")
    if not endpoint:
        print("ERROR: COSMOS_ENDPOINT not set", file=sys.stderr)
        return 2

    client = CosmosClient(endpoint, credential=DefaultAzureCredential())
    db = client.get_database_client(db_name)

    print(f"Endpoint: {endpoint}")
    print(f"Database: {db_name}")
    print("-" * 60)

    # 1) lessons_v2
    lessons_v2 = db.get_container_client("lessons_v2")
    count_query = (
        "SELECT VALUE COUNT(1) FROM c WHERE c.repoId=@r"
    )
    total = list(
        lessons_v2.query_items(
            query=count_query,
            parameters=[{"name": "@r", "value": "samoletovs__nauroLabs"}],
            enable_cross_partition_query=False,
            partition_key="samoletovs__nauroLabs",
        )
    )
    print(f"lessons_v2 count for samoletovs__nauroLabs: {total[0]}")

    # by language
    lang_q = (
        "SELECT c.language, COUNT(1) AS n FROM c WHERE c.repoId=@r GROUP BY c.language"
    )
    by_lang = list(
        lessons_v2.query_items(
            query=lang_q,
            parameters=[{"name": "@r", "value": "samoletovs__nauroLabs"}],
            partition_key="samoletovs__nauroLabs",
        )
    )
    print(f"  by language: {by_lang}")

    # by status
    status_q = (
        "SELECT c.status, COUNT(1) AS n FROM c WHERE c.repoId=@r GROUP BY c.status"
    )
    by_status = list(
        lessons_v2.query_items(
            query=status_q,
            parameters=[{"name": "@r", "value": "samoletovs__nauroLabs"}],
            partition_key="samoletovs__nauroLabs",
        )
    )
    print(f"  by status:   {by_status}")

    # sample doc — full shape
    sample = list(
        lessons_v2.query_items(
            query="SELECT TOP 1 * FROM c WHERE c.repoId=@r",
            parameters=[{"name": "@r", "value": "samoletovs__nauroLabs"}],
            partition_key="samoletovs__nauroLabs",
        )
    )
    if sample:
        s = sample[0]
        public_keys = sorted(k for k in s.keys() if not k.startswith("_"))
        print(f"  sample id={s['id']}")
        print(f"  sample title={(s.get('title') or '')[:60]!r}")
        print(f"  sample language={s.get('language')} status={s.get('status')} topic={s.get('topic')}")
        print(f"  sample fields: {public_keys}")
        print(f"  body length: {len(s.get('body') or '')} chars")
        print(f"  body_original present: {bool(s.get('body_original'))}")
        print(f"  citations: {len(s.get('citations') or [])}")
        print(f"  suggested_next: {len(s.get('suggested_next') or [])}")

    # 2) repos
    repos = db.get_container_client("repos")
    repo_docs = list(
        repos.query_items(
            query="SELECT * FROM c WHERE c.id=@id",
            parameters=[{"name": "@id", "value": "samoletovs__nauroLabs"}],
            partition_key="samoletovs",
        )
    )
    print(f"repos doc(s): {len(repo_docs)}")
    if repo_docs:
        r = repo_docs[0]
        print(
            f"  repoId={r.get('repoId')} ownerId={r.get('ownerId')} "
            f"visibility={r.get('visibility')} githubUrl={r.get('githubUrl')}"
        )

    # 3) lessonProgress
    progress = db.get_container_client("lessonProgress")
    progress_count = list(
        progress.query_items(
            query="SELECT VALUE COUNT(1) FROM c WHERE c.userId=@u",
            parameters=[{"name": "@u", "value": "samoletovs"}],
            partition_key="samoletovs",
        )
    )
    print(f"lessonProgress count for samoletovs: {progress_count[0]}")

    # 4) users
    users = db.get_container_client("users")
    user_doc = list(
        users.query_items(
            query="SELECT * FROM c WHERE c.id=@id",
            parameters=[{"name": "@id", "value": "samoletovs"}],
            partition_key="samoletovs",
        )
    )
    print(f"users doc(s): {len(user_doc)}")
    if user_doc:
        u = user_doc[0]
        print(
            f"  userId={u.get('userId')} githubLogin={u.get('githubLogin')} "
            f"createdAt={u.get('createdAt')}"
        )

    print("-" * 60)
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
