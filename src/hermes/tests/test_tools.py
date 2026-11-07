"""Tests of registering the tools and of the handler that runs one through the command line."""

from __future__ import annotations

import json
import unittest
from typing import Any
from unittest import mock

from support import CWD, FAKE_CLI, LISTING, FakeCliCase, project, runtime, tools


class RegisterTest(FakeCliCase):
    def test_registers_each_listed_tool(self) -> None:
        ctx = self.register()
        self.assertEqual(list(ctx.tools), [entry["id"] for entry in LISTING])
        create = ctx.tools["demo_thing_create"]
        self.assertEqual(
            create["schema"],
            {
                "name": "demo_thing_create",
                "description": "Description of demo_thing_create",
                "parameters": LISTING[1]["input_schema"],
            },
        )
        self.assertEqual(create["description"], "Create a thing")
        self.assertTrue(callable(create["handler"]))

    def test_groups_tools_by_toolset_without_emoji_by_default(self) -> None:
        ctx = self.register()
        self.assertEqual(
            {tool_id: (tool["toolset"], tool["emoji"]) for tool_id, tool in ctx.tools.items()},
            {
                "demo_thing_read": (f"{project.PLUGIN_NAME}-things", ""),
                "demo_thing_create": (f"{project.PLUGIN_NAME}-things", ""),
                "demo_widget_update": (f"{project.PLUGIN_NAME}-widgets", ""),
                "demo_item_add": (f"{project.PLUGIN_NAME}-items", ""),
                "demo_gadget_edit": (f"{project.PLUGIN_NAME}-gadgets", ""),
                "demo_bundle_publish": (f"{project.PLUGIN_NAME}-bundles", ""),
                "demo_task_run": (f"{project.PLUGIN_NAME}-tasks", ""),
            },
        )

    def test_groups_tools_by_toolset_with_configured_emoji(self) -> None:
        with mock.patch.dict(tools.TOOLSET_EMOJI, {"things": "🧩", "widgets": "🔀"}):
            ctx = self.register()
            self.assertEqual(ctx.tools["demo_thing_read"]["emoji"], "🧩")
            self.assertEqual(ctx.tools["demo_thing_create"]["emoji"], "🧩")
            self.assertEqual(ctx.tools["demo_widget_update"]["emoji"], "🔀")
            self.assertEqual(ctx.tools["demo_item_add"]["emoji"], "")

    def test_registers_the_approval_hook_on_pre_tool_call(self) -> None:
        ctx = self.register()
        self.assertEqual([name for name, _ in ctx.hooks], ["pre_tool_call"])


class HandlerTest(FakeCliCase):
    def handler(self, tool_id: str = "demo_thing_create", config: dict[str, Any] | None = None) -> Any:
        return self.register(config).tools[tool_id]["handler"]

    def run_calls(self) -> list[dict[str, Any]]:
        return [call for call in self.calls() if call["argv"][0] == "run"]

    def test_passes_the_arguments_on_stdin_and_the_cwd_and_flags(self) -> None:
        stdout = json.dumps({"result": {"number": 12}}) + "\n"
        self.reply("run demo_thing_create", stdout=stdout)
        handler = self.handler(config={"toolsets": ["things"], "read_only": False, "exclude_tools": ["demo_widget_update"]})
        handler({"name": "thing-1", "body": "héllo ✓"})
        [call] = self.run_calls()
        self.assertEqual(
            call["argv"],
            ["run", "demo_thing_create", "--cwd", CWD, "--toolsets", "things", "--exclude-tools", "demo_widget_update"],
        )
        self.assertEqual(json.loads(call["stdin"]), {"name": "thing-1", "body": "héllo ✓"})

    def test_returns_the_success_document_as_it_is(self) -> None:
        self.reply("run demo_thing_create", stdout='{"result":{"url":"https://example.test/1"}}\n')
        self.assertEqual(self.handler()({}), '{"result":{"url":"https://example.test/1"}}')

    def test_accepts_the_keyword_arguments_hermes_adds(self) -> None:
        self.reply("run demo_thing_create", stdout='{"result":{}}\n')
        self.assertEqual(self.handler()({}, task_id="t1", user_task="x"), '{"result":{}}')

    def test_maps_a_tool_error_to_code_and_message(self) -> None:
        error = {"error": {"code": "not_found", "message": "No such thing."}}
        self.reply("run demo_thing_create", stdout=json.dumps(error) + "\n", code=1)
        self.assertEqual(json.loads(self.handler()({})), {"error": "not_found: No such thing."})

    def test_appends_a_tool_error_s_details_as_json_on_its_own_line(self) -> None:
        details = {"problems": [{"field": "name", "reason": "空"}]}
        stdout = (
            '{"error":{"code":"invalid_argument","message":"The thing has problems.",'
            '"details":{"problems":[{"field":"name","reason":"空"}]}}}\n'
        )
        self.reply("run demo_thing_create", stdout=stdout, code=1)
        result = json.loads(self.handler()({}))
        message, details_line = result["error"].split("\n", 1)
        self.assertEqual(message, "invalid_argument: The thing has problems.")
        self.assertEqual(json.loads(details_line), details)
        self.assertEqual(details_line, '{"problems":[{"field":"name","reason":"空"}]}')

    def test_ignores_details_that_are_not_an_object(self) -> None:
        for details in (["problem"], "problem"):
            error = {"error": {"code": "not_found", "message": "No such thing.", "details": details}}
            self.reply("run demo_thing_create", stdout=json.dumps(error) + "\n", code=1)
            self.assertEqual(json.loads(self.handler()({})), {"error": "not_found: No such thing."})

    def test_maps_an_exit_without_a_document_to_its_stderr(self) -> None:
        self.reply("run demo_thing_create", stderr=f"{project.CLI_NAME}: boom\n", code=2)
        self.assertEqual(json.loads(self.handler()({})), {"error": f"{project.CLI_NAME} failed: {project.CLI_NAME}: boom"})
        self.reply("run demo_thing_create", code=3)
        self.assertEqual(json.loads(self.handler()({})), {"error": f"{project.CLI_NAME} failed: exit status 3"})

    def test_maps_a_success_that_is_not_a_result_document_to_an_error(self) -> None:
        self.reply("run demo_thing_create", stdout="garbage")
        self.assertIn("error", json.loads(self.handler()({})))

    def test_a_timeout_is_an_error_result(self) -> None:
        self.reply("run demo_thing_create", sleep=5)
        handler = self.handler()
        with mock.patch.object(tools, "RUN_TIMEOUT_SECONDS", 0.3):
            result = json.loads(handler({}))
        self.assertIn("did not finish", result["error"])

    def test_a_cli_that_cannot_start_is_an_error_result(self) -> None:
        broken = runtime.Runtime(node=str(self.dir / "no-node"), cli=FAKE_CLI, skills_dir=self.skills_dir)
        result = json.loads(tools.make_handler(broken, "demo_thing_create", [])({}))
        self.assertIn("could not be started", result["error"])

    def test_arguments_that_are_not_json_are_an_error_result(self) -> None:
        result = json.loads(self.handler()({"value": object()}))
        self.assertIn("demo_thing_create could not run", result["error"])

    def test_a_failing_cwd_lookup_is_an_error_result(self) -> None:
        handler = self.handler()
        with mock.patch.object(tools, "agent_cwd", side_effect=OSError("cwd is gone")):
            result = json.loads(handler({}))
        self.assertIn("cwd is gone", result["error"])


if __name__ == "__main__":
    unittest.main()
