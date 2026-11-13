"""Tests of required plugins blocking writes before approval and execution, but never reads."""

from __future__ import annotations

import json
import unittest
from unittest import mock

from support import LISTING, FakeCliCase, StubContext, approval, listing, tools


class RequirePluginsCallsTest(FakeCliCase):
    def test_missing_plugins_block_every_write_before_target_and_run(self) -> None:
        ctx = self.register(ctx=StubContext({"require_plugins": ["guard"]}, loaded=set()))
        for tool in LISTING:
            if tool["class"] == "read":
                continue
            with self.subTest(tool=tool["id"]):
                decision = ctx.hooks[0][1](tool_name=tool["id"], args={})
                self.assertEqual(decision["action"], "block")
                self.assertTrue(decision["message"].startswith("forbidden:"))
                self.assertIn("guard", decision["message"])
                result = json.loads(ctx.tools[tool["id"]]["handler"]({}))
                self.assertEqual(result, {"error": decision["message"]})
        self.assertEqual([call["argv"][0] for call in self.calls()], ["list"])

    def test_reads_do_not_check_plugins_and_still_run(self) -> None:
        self.reply("run demo_thing_read", stdout='{"result":{}}')
        ctx = self.register(ctx=StubContext({"require_plugins": ["guard"]}, loaded=set()))
        self.assertIsNone(ctx.hooks[0][1](tool_name="demo_thing_read", args={}))
        self.assertEqual(json.loads(ctx.tools["demo_thing_read"]["handler"]({})), {"result": {}})
        self.assertEqual(ctx.has_plugin_calls, [])
        self.assertEqual([call["argv"][0] for call in self.calls()], ["list", "run"])

    def test_loading_then_unloading_a_plugin_changes_existing_hooks_and_handlers(self) -> None:
        self.reply("target demo_thing_create", stdout='{"resources":["target/one"]}')
        self.reply("run demo_thing_create", stdout='{"result":{}}')
        ctx = self.register(ctx=StubContext({"require_plugins": ["guard"]}, loaded=set()))
        hook = ctx.hooks[0][1]
        handler = ctx.tools["demo_thing_create"]["handler"]
        self.assertEqual(hook(tool_name="demo_thing_create", args={})["action"], "block")
        ctx.loaded.add("guard")
        self.assertEqual(hook(tool_name="demo_thing_create", args={})["action"], "approve")
        self.assertEqual(json.loads(handler({})), {"result": {}})
        ctx.loaded.remove("guard")
        self.assertTrue(json.loads(handler({}))["error"].startswith("forbidden:"))
        self.assertEqual([call["argv"][0] for call in self.calls()], ["list", "target", "run"])

    def test_unset_and_empty_requirements_never_check_plugins(self) -> None:
        self.reply("target demo_thing_create", stdout='{"resources":["target/one"]}')
        self.reply("run demo_thing_create", stdout='{"result":{}}')
        for config in ({}, {"require_plugins": []}):
            with self.subTest(config=config):
                ctx = self.register(ctx=StubContext(config, loaded=set()))
                decision = ctx.hooks[0][1](tool_name="demo_thing_create", args={})
                self.assertEqual(decision["action"], "approve")
                self.assertEqual(json.loads(ctx.tools["demo_thing_create"]["handler"]({})), {"result": {}})
                self.assertEqual(ctx.has_plugin_calls, [])

    def test_an_older_context_without_has_plugin_refuses_writes(self) -> None:
        ctx = self.register({"require_plugins": ["guard"]})
        self.assertFalse(hasattr(ctx, "has_plugin"))
        self.assertEqual(ctx.hooks[0][1](tool_name="demo_thing_create", args={})["action"], "block")
        self.assertTrue(json.loads(ctx.tools["demo_thing_create"]["handler"]({}))["error"].startswith("forbidden:"))
        self.assertEqual([call["argv"][0] for call in self.calls()], ["list"])

    def test_a_wrong_setting_registers_nothing(self) -> None:
        with self.assertLogs(level="WARNING") as logged:
            ctx = self.register({"require_plugins": "guard"})
        self.assertEqual(ctx.tools, {})
        self.assertEqual(ctx.hooks, [])
        self.assertEqual(ctx.skills, [])
        self.assertEqual(self.calls(), [])
        self.assertIn('setting "require_plugins" must be a list of names', logged.output[0])

    def test_a_block_clears_a_pin_left_by_an_earlier_approval(self) -> None:
        pin = "a" * 64
        self.reply("target demo_thing_create", stdout=json.dumps({"resources": ["target/one"], "pin": pin}))
        ctx = self.register(ctx=StubContext({"require_plugins": ["guard"]}, loaded={"guard"}))
        call = {"tool_name": "demo_thing_create", "args": {}, "tool_call_id": "call"}
        self.assertEqual(ctx.hooks[0][1](**call)["action"], "approve")
        ctx.loaded.clear()
        self.assertEqual(ctx.hooks[0][1](**call)["action"], "block")
        self.assertEqual(ctx.hooks[1][1](**call), {"action": "modify", "args": {approval.PIN_ARGUMENT: ""}})
        self.assertEqual([call["argv"][0] for call in self.calls()], ["list", "target"])

    def test_a_guard_that_raises_blocks_and_clears_the_pin(self) -> None:
        tools = [listing.ToolInfo.from_listing(entry) for entry in LISTING]
        pins = approval.PinStash()
        pins.put(("", "", "call"), "a" * 64)
        guard = mock.Mock(side_effect=RuntimeError("unavailable"))
        hook = approval.make_hook(self.runtime, tools, pins=pins, guard=guard)
        decision = hook(tool_name="demo_thing_create", args={}, tool_call_id="call")
        self.assertEqual(decision, {"action": "block", "message": "forbidden: the required plugins could not be checked"})
        self.assertIsNone(pins.take(("", "", "call")))
        self.assertEqual(self.calls(), [])

    def test_a_guard_that_raises_or_answers_blank_refuses_in_the_hook_and_the_handler(self) -> None:
        catalog = [listing.ToolInfo.from_listing(entry) for entry in LISTING]
        for guard in (mock.Mock(side_effect=RuntimeError("unavailable")), mock.Mock(return_value="")):
            with self.subTest(guard=guard):
                hook = approval.make_hook(self.runtime, catalog, guard=guard)
                self.assertEqual(hook(tool_name="demo_thing_create", args={})["action"], "block")
                handler = tools.make_handler(self.runtime, "demo_thing_create", [], guard)
                self.assertIn("error", json.loads(handler({})))
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
