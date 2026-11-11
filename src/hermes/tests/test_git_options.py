"""The options of git-tools, ``published_text_rules`` and ``worktree_root``, as the plugin passes them on."""

from __future__ import annotations

import unittest
from typing import Any

from support import CWD, FakeCliCase, StubContext, project, settings

RULES_FLAGS = ["--published-text-rules", "/etc/rules.json"]


class GitOptionFlagsTest(unittest.TestCase):
    def flags(self, **config: Any) -> list[str]:
        return settings.settings_flags(StubContext(config))

    def test_the_options_are_both_text(self) -> None:
        self.assertEqual(project.OPTIONS, {"published_text_rules": "text", "worktree_root": "text"})

    def test_the_worktree_root_becomes_its_flag(self) -> None:
        self.assertEqual(self.flags(worktree_root=" ~/trees "), ["--worktree-root", "~/trees"])
        self.assertEqual(self.flags(worktree_root=" "), [])

    def test_an_option_becomes_its_flag_after_the_other_settings(self) -> None:
        self.assertEqual(
            self.flags(published_text_rules="/etc/rules.json", read_only=True),
            ["--read-only", *RULES_FLAGS],
        )

    def test_the_option_is_stripped(self) -> None:
        self.assertEqual(self.flags(published_text_rules=" /etc/rules.json \n"), RULES_FLAGS)

    def test_absent_and_blank_options_give_no_flag(self) -> None:
        for config in ({}, {"published_text_rules": None}, {"published_text_rules": ""}, {"worktree_root": " \t"}):
            with self.subTest(config=config):
                self.assertEqual(self.flags(**config), [])

    def test_an_option_that_is_not_text_is_refused(self) -> None:
        for name in ("published_text_rules", "worktree_root"):
            for value in (3, True, ["/etc/rules.json"], {"path": "/etc/rules.json"}):
                with self.subTest(name=name, value=value), self.assertRaises(settings.SettingsError):
                    self.flags(**{name: value})

    def test_option_flags_are_the_option_part_alone(self) -> None:
        ctx = StubContext({"published_text_rules": "/etc/rules.json", "read_only": True, "tools": ["demo_thing_read"]})
        self.assertEqual(settings.option_flags(ctx), RULES_FLAGS)


class GitOptionsReachTheCommandsTest(FakeCliCase):
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
        self.assertEqual(self.argv_of("list"), [["list", *RULES_FLAGS]])
        self.assertEqual(self.argv_of("run"), [["run", "demo_thing_create", "--cwd", CWD, *RULES_FLAGS]])
        self.assertEqual(self.argv_of("target"), [["target", "demo_thing_create", "--cwd", CWD, *RULES_FLAGS]])

    def test_target_gets_no_other_setting_flag(self) -> None:
        self.use({"published_text_rules": "/etc/rules.json", "read_only": False, "exclude_tools": ["demo_widget_update"]})
        [target] = self.argv_of("target")
        self.assertEqual(target, ["target", "demo_thing_create", "--cwd", CWD, *RULES_FLAGS])

    def test_target_puts_the_option_flags_after_the_language_ones(self) -> None:
        self.use({"published_text_rules": "/etc/rules.json", "language": "ja"})
        [target] = self.argv_of("target")
        self.assertEqual(target, ["target", "demo_thing_create", "--cwd", CWD, "--language=ja", *RULES_FLAGS])

    def test_without_the_option_no_command_gets_a_flag_for_it(self) -> None:
        self.use({})
        for call in self.calls():
            self.assertNotIn("--published-text-rules", call["argv"])

    def test_every_option_of_the_project_reaches_the_commands(self) -> None:
        self.use({"published_text_rules": "/etc/rules.json", "worktree_root": "/srv/trees"})
        expected = [*RULES_FLAGS, "--worktree-root", "/srv/trees"]
        self.assertEqual(self.argv_of("run"), [["run", "demo_thing_create", "--cwd", CWD, *expected]])

    def test_a_wrong_option_registers_nothing(self) -> None:
        ctx = self.register({"published_text_rules": 3})
        self.assertEqual(ctx.tools, {})
        self.assertEqual(ctx.hooks, [])


if __name__ == "__main__":
    unittest.main()
