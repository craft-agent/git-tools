"""Tests of asking the command line for the tools, and of registering nothing when it cannot answer."""

from __future__ import annotations

import unittest
from typing import Any
from unittest import mock

from support import FAKE_CLI, FakeCliCase, StubContext, listing, plugin, project, runtime


class ListingTest(FakeCliCase):
    def test_passes_the_settings_to_list_as_flags(self) -> None:
        self.register({"toolsets": ["gadgets"], "read_only": True, "exclude_tools": ["demo_gadget_edit"]})
        self.assertEqual(
            [call["argv"] for call in self.calls()],
            [["list", "--toolsets", "gadgets", "--read-only", "--exclude-tools", "demo_gadget_edit"]],
        )

    def test_an_empty_list_registers_no_tool(self) -> None:
        self.reply("list", stdout="[]")
        ctx = self.register()
        self.assertEqual(ctx.tools, {})

    def assert_registers_nothing(self, ctx: StubContext, logs: Any) -> None:
        self.assertEqual((ctx.tools, ctx.hooks, ctx.skills), ({}, [], []))
        self.assertEqual(len(logs.records), 1)
        self.assertIn("registers nothing", logs.output[0])

    def test_missing_node_or_cli_registers_nothing_and_warns_once(self) -> None:
        for unavailable in (
            runtime.Unavailable("node was not found"),
            runtime.Unavailable("dist/cli.js is missing"),
        ):
            with self.subTest(reason=str(unavailable)), mock.patch.object(
                plugin, "locate_runtime", side_effect=unavailable
            ), self.assertLogs(plugin.logger, "WARNING") as logs:
                ctx = StubContext()
                plugin.register(ctx)
                self.assert_registers_nothing(ctx, logs)
                self.assertIn(str(unavailable), logs.output[0])

    def test_a_failing_list_registers_nothing_and_warns_once(self) -> None:
        for fields in (
            {"code": 2, "stderr": f"{project.CLI_NAME}: Unknown toolset \"bogus\"\n"},
            {"code": 0, "stdout": "not json"},
            {"code": 0, "stdout": '{"not": "a list"}'},
            {"code": 0, "stdout": '[{"id": "demo_thing_read"}]'},
        ):
            with self.subTest(fields=fields), self.assertLogs(plugin.logger, "WARNING") as logs:
                self.reply("list", **fields)
                ctx = self.register()
                self.assert_registers_nothing(ctx, logs)

    def test_a_list_that_times_out_registers_nothing(self) -> None:
        self.reply("list", sleep=5)
        with mock.patch.object(listing, "LIST_TIMEOUT_SECONDS", 0.3), self.assertLogs(plugin.logger, "WARNING") as logs:
            ctx = self.register()
            self.assert_registers_nothing(ctx, logs)

    def test_a_cli_that_cannot_start_registers_nothing(self) -> None:
        self.runtime = runtime.Runtime(node=str(self.dir / "no-node"), cli=FAKE_CLI, skills_dir=self.skills_dir)
        with self.assertLogs(plugin.logger, "WARNING") as logs:
            ctx = self.register()
            self.assert_registers_nothing(ctx, logs)

    def test_a_wrong_setting_registers_nothing_and_warns_once(self) -> None:
        with self.assertLogs(plugin.logger, "WARNING") as logs:
            ctx = self.register({"read_only": "yes"})
            self.assert_registers_nothing(ctx, logs)
            self.assertIn("read_only", logs.output[0])
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
