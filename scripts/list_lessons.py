"""Quick check: list all lessons in Cosmos."""
import os
from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv

load_dotenv("atlas/.env")
client = CosmosClient(
    os.environ["COSMOS_ENDPOINT"],
    credential=DefaultAzureCredential(),
)
container = client.get_database_client("atlas").get_container_client("lessons")
items = list(
    container.query_items(
        "SELECT c.id, c.title, c.topic, c.depth, c.read_minutes FROM c",
        enable_cross_partition_query=True,
    )
)
print(f"Lessons in Cosmos: {len(items)}")
for it in items:
    print(
        f"  - {it['id']:55s} {it['topic']:45s} {it['depth']:15s} {it.get('read_minutes', '?')}min"
    )
