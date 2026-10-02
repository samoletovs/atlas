"""Classic-agent isolation tests; no credential discovery or Azure requests."""

import os
import runpy
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


class ClassicModelBoundaryTests(unittest.TestCase):
    def load(self, **settings: str) -> dict:
        environment = {
            "COSMOS_ENDPOINT": "https://synthetic.invalid",
            "FOUNDRY_PROJECT_ENDPOINT": "https://synthetic.invalid/api/projects/test",
            **settings,
        }
        with patch.dict(os.environ, environment, clear=True), patch("dotenv.load_dotenv"):
            return runpy.run_path(str(Path(__file__).with_name("generate_lessons.py")))

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


if __name__ == "__main__":
    unittest.main()
