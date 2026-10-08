"""Foundry Agent Service (new API) contract tests with a fake project client.

No credential discovery or Azure requests: the project and OpenAI clients are fakes.
"""

import json
import os
import re
import runpy
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from azure.ai.projects.models import PromptAgentDefinition
from azure.core.exceptions import ResourceNotFoundError

SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parent
LESSON = {"title": "T", "body": "Lesson body.", "topic": "x", "citations": [], "suggested_next": []}


def load() -> dict:
    environment = {
        "COSMOS_ENDPOINT": "https://synthetic.invalid",
        "FOUNDRY_PROJECT_ENDPOINT": "https://synthetic.invalid/api/projects/test",
    }
    with patch.dict(os.environ, environment, clear=True), patch("dotenv.load_dotenv"):
        return runpy.run_path(str(SCRIPTS / "generate_lessons.py"))


def response(status: str = "completed", text: str = "", **extra: object) -> SimpleNamespace:
    fields = {"id": "resp_test", "status": status, "output_text": text,
              "error": None, "incomplete_details": None, **extra}
    return SimpleNamespace(**fields)


def stored_agent(version: str, **definition: object) -> SimpleNamespace:
    return SimpleNamespace(versions=SimpleNamespace(latest=SimpleNamespace(
        version=version, definition=PromptAgentDefinition(**definition),
    )))


class AgentServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load()
        self.openai = Mock()
        self.project = Mock()
        self.client = self.module["FoundryAgents"](project=self.project, _openai=self.openai)
        self.agent = self.module["AgentRef"](name="atlas-teacher", version="7")


class ResponseInvocationTests(AgentServiceTests):
    def test_lesson_request_pins_the_agent_name_and_version(self) -> None:
        self.openai.responses.create.return_value = response(text="```json\n" + json.dumps(LESSON) + "\n```")
        payload = self.module["generate_lesson"](
            self.client, self.agent, {"topic": "managed-identity", "depth": "intro"},
        )
        kwargs = self.openai.responses.create.call_args.kwargs
        self.assertEqual(kwargs["extra_body"], {"agent_reference": {
            "name": "atlas-teacher", "version": "7", "type": "agent_reference",
        }})
        self.assertEqual(json.loads(kwargs["input"])["topic"], "managed-identity")
        self.assertIs(kwargs["store"], False)
        self.assertNotIn("model", kwargs)
        self.assertEqual(payload["body"], "Lesson body.")
        self.assertEqual(payload["topic"], "managed-identity")

    def test_unsuccessful_responses_are_never_parsed_as_output(self) -> None:
        valid = json.dumps(LESSON)
        for status in ("failed", "incomplete", "cancelled", "in_progress", "queued", None):
            with self.subTest(status=status):
                self.openai.responses.create.return_value = response(
                    status, valid, incomplete_details={"reason": "max_output_tokens"},
                )
                with self.assertRaisesRegex(RuntimeError, f"status={status}"):
                    self.module["generate_lesson"](
                        self.client, self.agent, {"topic": "x", "depth": "intro"},
                    )
                with self.assertRaisesRegex(RuntimeError, "Run failed"):
                    self.module["enhance_lesson_body"](self.client, self.agent, {}, "body")
                with self.assertRaisesRegex(RuntimeError, "Planner run failed"):
                    self.module["_run_planner"](
                        self.client, self.agent, {}, [], "", [], 1, "en",
                    )

    def test_empty_completed_output_is_a_failure(self) -> None:
        self.openai.responses.create.return_value = response(text="   ")
        with self.assertRaisesRegex(RuntimeError, "empty output"):
            self.module["generate_lesson"](self.client, self.agent, {"topic": "x", "depth": "intro"})

    def test_failed_generation_leaves_the_queued_lesson_unpublished(self) -> None:
        self.openai.responses.create.return_value = response("failed", json.dumps(LESSON))
        cosmos = Mock()
        with patch.dict(
            self.module["run_pending"].__globals__,
            get_cosmos_client=Mock(return_value=cosmos),
            fetch_pending_lessons=Mock(return_value=[{"id": "q", "topic": "x", "title": "X"}]),
            make_agents_client=Mock(return_value=self.client),
            get_or_create_atlas_agent=Mock(return_value=self.agent),
        ):
            self.assertEqual(self.module["run_pending"](), 0)
        stored = cosmos.get_database_client.return_value.get_container_client.return_value
        stored.replace_item.assert_not_called()

    def test_planner_and_enhancer_parse_their_json_contracts(self) -> None:
        planner = self.module["AgentRef"](name="atlas-planner", version="2")
        self.openai.responses.create.return_value = response(text=json.dumps({"items": [
            {"title": "Managed identity", "topic": "Managed-Identity", "depth": "deep",
             "rationale": "Why.", "source_sha": "abc", "source_summary": "wire creds"},
            {"title": "Dup", "topic": "existing", "depth": "intro"},
        ]}))
        items = self.module["_run_planner"](
            self.client, planner, {"repoId": "o/r"}, [], "", ["existing"], 2, "en",
        )
        self.assertEqual([i["topic"] for i in items], ["managed-identity"])
        self.assertEqual(
            self.openai.responses.create.call_args.kwargs["extra_body"]["agent_reference"]["version"], "2",
        )
        self.openai.responses.create.return_value = response(text=json.dumps({"nobody": 1}))
        with self.assertRaisesRegex(RuntimeError, "no 'body' field"):
            self.module["enhance_lesson_body"](self.client, self.agent, {}, "body")


class AgentVersioningTests(AgentServiceTests):
    def test_unchanged_definition_reuses_the_latest_version(self) -> None:
        self.project.agents.get.return_value = stored_agent(
            "4", model="gpt-4o-mini", instructions=self.module["LIBRARIAN_INSTRUCTIONS"], temperature=0.4,
        )
        ref = self.module["get_or_create_atlas_agent"](self.client)
        self.assertEqual((ref.name, ref.version), ("atlas-teacher", "4"))
        self.project.agents.get.assert_called_once_with("atlas-teacher")
        self.project.agents.create_version.assert_not_called()

    def test_changed_or_missing_definition_creates_and_pins_a_new_version(self) -> None:
        planner = self.module["PLANNER_INSTRUCTIONS"]
        for name, stored in (
            ("missing", ResourceNotFoundError("absent")),
            ("instructions", stored_agent("1", model="gpt-4o-mini", instructions="old", temperature=0.5)),
            ("temperature", stored_agent("1", model="gpt-4o-mini", instructions=planner, temperature=0.9)),
            ("model", stored_agent("1", model="gpt-4.1", instructions=planner, temperature=0.5)),
        ):
            with self.subTest(name=name):
                self.project.reset_mock()
                if isinstance(stored, Exception):
                    self.project.agents.get.side_effect = stored
                else:
                    self.project.agents.get.side_effect = None
                    self.project.agents.get.return_value = stored
                self.project.agents.create_version.return_value = SimpleNamespace(version="2")
                ref = self.module["_get_or_create_planner_agent"](self.client)
                self.assertEqual((ref.name, ref.version), ("atlas-planner", "2"))
                kwargs = self.project.agents.create_version.call_args.kwargs
                self.assertEqual(kwargs["agent_name"], "atlas-planner")
                definition = kwargs["definition"]
                self.assertEqual((definition.model, definition.instructions, definition.temperature),
                                 ("gpt-4o-mini", planner, 0.5))

    def test_enhancer_version_follows_the_known_topic_set(self) -> None:
        self.project.agents.create_version.return_value = SimpleNamespace(version="9")
        self.project.agents.get.side_effect = ResourceNotFoundError("absent")
        self.module["get_or_create_enhancer_agent"](self.client, ["b", "a", "a"])
        instructions = self.project.agents.create_version.call_args.kwargs["definition"].instructions
        self.assertIn("   - a\n   - b", instructions)
        self.assertNotIn("%KNOWN_TOPICS%", instructions)

        self.project.reset_mock()
        self.project.agents.get.side_effect = None
        self.project.agents.get.return_value = stored_agent(
            "9", model="gpt-4o-mini", instructions=instructions, temperature=0.2,
        )
        self.assertEqual(self.module["get_or_create_enhancer_agent"](self.client, ["a", "b"]).version, "9")
        self.project.agents.create_version.assert_not_called()
        self.module["get_or_create_enhancer_agent"](self.client, ["a", "b", "c"])
        self.project.agents.create_version.assert_called_once()


class ClassicSdkRemovedTests(unittest.TestCase):
    CLASSIC = re.compile(r"azure[.-]ai[.-]agents|AgentsClient|MessageRole|ListSortOrder")

    def test_requirements_use_the_new_agent_service_sdk(self) -> None:
        requirements = [
            line.split("#")[0].strip()
            for line in (SCRIPTS / "requirements.txt").read_text(encoding="utf-8").splitlines()
        ]
        self.assertIn("azure-ai-projects>=2.1.0,<2.5", requirements)
        self.assertIn("openai>=2.8.0,<3", requirements)
        self.assertFalse([r for r in requirements if r.lower().startswith("azure-ai-agents")])

    def test_no_script_or_workflow_references_the_classic_sdk(self) -> None:
        files = [p for p in SCRIPTS.glob("*.py") if p.name != Path(__file__).name]
        files += list((REPO / ".github" / "workflows").glob("*.yml"))
        offenders = [p.name for p in files if self.CLASSIC.search(p.read_text(encoding="utf-8"))]
        self.assertEqual(offenders, [])


if __name__ == "__main__":
    unittest.main()
