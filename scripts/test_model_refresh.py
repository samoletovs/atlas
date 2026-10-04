"""Classic-agent isolation tests; no credential discovery or Azure requests."""

import json
import os
import runpy
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


class GeneratorTests(unittest.TestCase):
    def load(self, **settings: str) -> dict:
        environment = {
            "COSMOS_ENDPOINT": "https://synthetic.invalid",
            "FOUNDRY_PROJECT_ENDPOINT": "https://synthetic.invalid/api/projects/test",
            **settings,
        }
        with patch.dict(os.environ, environment, clear=True), patch("dotenv.load_dotenv"):
            return runpy.run_path(str(Path(__file__).with_name("generate_lessons.py")))


class ClassicModelBoundaryTests(GeneratorTests):
    def test_api_default_cannot_silently_upgrade_the_classic_agents(self) -> None:
        for model in ("gpt-6-luna", "gpt-6-sol"):
            module = self.load(FOUNDRY_DEPLOYMENT=model)
            client = Mock()
            with (
                patch.dict(module["make_agents_client"].__globals__, AgentsClient=client),
                self.assertRaisesRegex(ValueError, "separate promotion gate"),
            ):
                module["make_agents_client"]()
            client.assert_not_called()

    def test_explicit_classic_rollback_overrides_the_api_model(self) -> None:
        for model in ("gpt-4o-mini", "gpt-4.1"):
            module = self.load(FOUNDRY_DEPLOYMENT="gpt-6-luna", FOUNDRY_AGENT_DEPLOYMENT=model)
            self.assertEqual(module["FOUNDRY_DEPLOYMENT"], model)
            client, credential = Mock(), Mock()
            with patch.dict(
                module["make_agents_client"].__globals__,
                AgentsClient=client, DefaultAzureCredential=credential,
            ):
                module["make_agents_client"]()
            client.assert_called_once()

    def test_workflow_keeps_classic_agents_on_the_supported_rollback(self) -> None:
        workflow = (
            Path(__file__).resolve().parents[1] / ".github" / "workflows" / "auto-generate.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("vars.FOUNDRY_AGENT_DEPLOYMENT || 'gpt-4o-mini'", workflow)
        self.assertIn("cron: '0 */8 * * *'", workflow)


class SuggestionRecoveryTests(GeneratorTests):
    def setUp(self) -> None:
        self.module = self.load()
        self.suggestions = [
            {
                "title": "Azure Functions для агентных платформ",
                "topic": "agent-platforms/azure-functions",
                "rationale": "Изучить выполнение инструментов агента без управления сервером.",
            },
            {
                "title": "Logic Apps для агентных платформ",
                "topic": "agent-platforms/logic-apps",
                "rationale": "Связать агента с бизнес-процессами и готовыми коннекторами.",
            },
        ]

    def sanitize(self, body: str, **fields: object) -> dict:
        return self.module["_sanitize_lesson_payload"]({"body": body, **fields})

    def test_recovers_russian_objects_arrays_and_bullets_without_heading(self) -> None:
        objects = [json.dumps(item, ensure_ascii=False) for item in self.suggestions]
        for raw in (
            ",\n".join(objects),
            ", ".join(objects),
            "\n".join(f"- {obj}" for obj in objects),
            json.dumps(self.suggestions, ensure_ascii=False, indent=2),
        ):
            with self.subTest(raw=raw):
                result = self.sanitize(f"Содержательный урок.\n\n{raw}\n\nПродолжение урока.")
                self.assertEqual(result["suggested_next"], self.suggestions)
                self.assertEqual(result["body"].split(), ["Содержательный", "урок.", "Продолжение", "урока."])

    def test_recognizes_next_headings_without_truncating_later_prose(self) -> None:
        for heading in (
            "## Что изучить дальше",
            "**Что изучать дальше:**",
            "Следующие шаги:",
            "### Рекомендуемые следующие темы",
            "## What to learn next",
            "**Suggested next steps**:",
            "Next steps:",
        ):
            with self.subTest(heading=heading):
                result = self.sanitize(
                    f"Урок.\n\n{heading}\n\n{json.dumps(self.suggestions)}\n\n"
                    "Важное продолжение.\n\n## Практика\n\nНе удалять."
                )
                self.assertEqual(result["suggested_next"], self.suggestions)
                self.assertNotIn(heading, result["body"])
                self.assertIn("Важное продолжение.\n\n## Практика\n\nНе удалять.", result["body"])
        self.assertEqual(self.sanitize("## Что изучить дальше\n\nОбычный текст.")["body"],
                         "## Что изучить дальше\n\nОбычный текст.")

    def test_structured_suggestions_win_and_topics_are_not_slugified(self) -> None:
        structured = {**self.suggestions[0], "title": "Авторитетный заголовок"}
        result = self.sanitize(
            "\n".join(json.dumps(item) for item in self.suggestions * 2),
            suggested_next=[structured, structured],
        )
        self.assertEqual(result["suggested_next"], [structured, self.suggestions[1]])
        self.assertEqual(result["body"], "")

    def test_json_escaping_field_order_and_length_boundary(self) -> None:
        item = {
            "rationale": 'Объясняет "tools", скобки { } и путь C:\\tools.',
            "topic": "a/" + "b" * 198,
            "title": "З" * 200,
        }
        result = self.sanitize(json.dumps(item, ensure_ascii=False, indent=2))
        self.assertEqual(result["suggested_next"], [item])
        self.assertEqual(result["body"], "")

    def test_invalid_suggestions_and_malformed_json_are_preserved(self) -> None:
        for invalid in (
            {"title": "Title", "topic": "valid"},
            {**self.suggestions[0], "rationale": "  "},
            {**self.suggestions[0], "rationale": None},
            {**self.suggestions[0], "topic": ""},
            {**self.suggestions[0], "title": 123},
            {**self.suggestions[0], "topic": "x" * 201},
            {**self.suggestions[0], "title": "x" * 201},
            {"unrelated": self.suggestions[0]},
            [self.suggestions[0], {"invalid": True}],
            [],
        ):
            body = json.dumps(invalid, indent=2)
            with self.subTest(invalid=invalid):
                result = self.sanitize(body, suggested_next=[invalid])
                self.assertEqual(result["body"], body)
                self.assertEqual(result["suggested_next"], [])
        body = '[\n  ' + json.dumps(self.suggestions[0]) + ',\n  {"broken": }\n]'
        self.assertEqual(self.sanitize(body)["body"], body)
        raw = json.dumps(self.suggestions[1])
        result = self.sanitize('{"broken": }\n' + raw)
        self.assertEqual(result["body"], '{"broken": }')
        self.assertEqual(result["suggested_next"], [self.suggestions[1]])

    def test_code_samples_and_inline_json_are_not_recovered(self) -> None:
        raw = json.dumps(self.suggestions[0], ensure_ascii=False)
        for body in (
            f"```json\n{raw}\n```",
            f"~~~json\n{raw}\n~~~",
            f"````markdown\n```json\n{raw}\n```\n````",
            f"    {raw}",
            f"Пример: {raw}",
            f"{raw} — пример формата.",
            f"## Что изучить дальше\n\n```json\n{raw}\n```",
        ):
            with self.subTest(body=body):
                result = self.sanitize(body)
                self.assertEqual(result["body"], body.strip())
                self.assertFalse(result.get("suggested_next"))

    def test_english_sources_still_salvage_urls_and_suggestions(self) -> None:
        result = self.sanitize(
            "Lesson.\n\n## Sources\n[Docs](https://learn.microsoft.com/example)\n"
            "https://learn.microsoft.com/example\n\n"
            + json.dumps(self.suggestions)
        )
        self.assertEqual(result["body"], "Lesson.")
        self.assertEqual(result["citations"], ["https://learn.microsoft.com/example"])
        self.assertEqual(result["suggested_next"], self.suggestions)

    def test_generation_preserves_requested_topic_over_model_output(self) -> None:
        client = Mock()
        client.runs.create_and_process.return_value.status = "completed"
        client.messages.list.return_value = [
            Mock(role=self.module["MessageRole"].AGENT, text_messages=[
                Mock(text=Mock(value=json.dumps({"body": "Lesson.", "topic": "model-changed"}))),
            ]),
        ]
        payload = self.module["generate_lesson"](
            client, "agent", {"topic": "agent-platforms/logic-apps", "depth": "intro"},
        )
        self.assertEqual(payload["topic"], "agent-platforms/logic-apps")
        client.threads.delete.assert_called_once()
        cosmos = Mock()
        queued = {
            "id": "queued-lesson", "topic": "agent-platforms/logic-apps",
            "title": "Logic Apps", "repoId": "repo", "language": "ru",
        }
        with patch.dict(
            self.module["run_pending"].__globals__,
            get_cosmos_client=Mock(return_value=cosmos),
            fetch_pending_lessons=Mock(return_value=[queued]),
            make_agents_client=Mock(return_value=client),
            get_or_create_atlas_agent=Mock(return_value="agent"),
        ):
            self.assertEqual(self.module["run_pending"](), 0)
        stored = cosmos.get_database_client.return_value.get_container_client.return_value
        self.assertEqual(stored.replace_item.call_args.kwargs["body"]["topic"],
                         "agent-platforms/logic-apps")


if __name__ == "__main__":
    unittest.main()
