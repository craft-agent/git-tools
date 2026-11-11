"""Tests that the tool options reach every command the plugin runs: ``list``, ``run`` and ``target``."""

from __future__ import annotations

import unittest
from typing import Any

from support import CWD, FakeCliCase

OPTION_FLAGS = ["--published-text-rules", "/etc/rules.json"]


class OptionFlagsReachTheCommandsTest(FakeCliCase):
    def argv_of(self, command: str) -> list[list[str]]:
        return [call["argv"] for call in self.calls() if call["argv"][0] == command]

    def use(self, config: dict[str, Any]) -> None:
        self.reply("run demo_thing_create", stdout='{"result":{}}')
        self.reply("target demo_thing_create", stdout='{"resources":["target/one"]}')
        ctx = self.register(config)
        ctx.hooks[0][1](tool_name="demo_thing_create", args={})
        ctx.tools["demo_thing_create"]["handler"]({})

    def test_list_run_and_target_all_get_the_option_flags(self) -> None:
        self.use({"published_text_rules": "/etc/rules.json"})
        self.assertEqual(self.argv_of("list"), [["list", *OPTION_FLAGS]])
        self.assertEqual(self.argv_of("run"), [["run", "demo_thing_create", "--cwd", CWD, *OPTION_FLAGS]])
        self.assertEqual(self.argv_of("target"), [["target", "demo_thing_create", "--cwd", CWD, *OPTION_FLAGS]])

    def test_target_gets_no_other_setting_flag(self) -> None:
        self.use({"published_text_rules": "/etc/rules.json", "read_only": False, "exclude_tools": ["demo_widget_update"]})
        [target] = self.argv_of("target")
        self.assertEqual(target, ["target", "demo_thing_create", "--cwd", CWD, *OPTION_FLAGS])

    def test_target_puts_the_option_flags_after_the_language_ones(self) -> None:
        self.use({"published_text_rules": "/etc/rules.json", "language": "ja"})
        [target] = self.argv_of("target")
        self.assertEqual(target, ["target", "demo_thing_create", "--cwd", CWD, "--language=ja", *OPTION_FLAGS])

    def test_without_the_option_no_command_gets_a_flag_for_it(self) -> None:
        self.use({})
        for call in self.calls():
            self.assertNotIn("--published-text-rules", call["argv"])

    def test_every_option_of_the_project_reaches_the_commands(self) -> None:
        self.use({"published_text_rules": "/etc/rules.json", "worktree_root": "/srv/trees"})
        expected = [*OPTION_FLAGS, "--worktree-root", "/srv/trees"]
        self.assertEqual(self.argv_of("run"), [["run", "demo_thing_create", "--cwd", CWD, *expected]])

    def test_a_wrong_option_registers_nothing(self) -> None:
        ctx = self.register({"published_text_rules": 3})
        self.assertEqual(ctx.tools, {})
        self.assertEqual(ctx.hooks, [])


if __name__ == "__main__":
    unittest.main()
