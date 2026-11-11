"""Tests of the settings the plugin turns into command-line flags."""

from __future__ import annotations

import unittest
from typing import Any
from unittest import mock

from support import StubContext, project, settings


class SettingsFlagsTest(unittest.TestCase):
    def flags(self, **config: Any) -> list[str]:
        return settings.settings_flags(StubContext(config))

    def test_no_setting_gives_no_flag(self) -> None:
        self.assertEqual(self.flags(), [])

    def test_each_setting_becomes_its_flag(self) -> None:
        self.assertEqual(
            self.flags(
                toolsets=["things", "widgets"],
                read_only=True,
                tools=["demo_thing_read"],
                exclude_tools=["demo_widget_update", "demo_gadget_edit"],
            ),
            [
                "--toolsets",
                "things,widgets",
                "--read-only",
                "--tools",
                "demo_thing_read",
                "--exclude-tools",
                "demo_widget_update,demo_gadget_edit",
            ],
        )

    def test_all_toolsets_as_text_or_as_a_list(self) -> None:
        self.assertEqual(self.flags(toolsets="all"), ["--toolsets", "all"])
        self.assertEqual(self.flags(toolsets=["all"]), ["--toolsets", "all"])

    def test_false_and_empty_settings_give_no_flag(self) -> None:
        self.assertEqual(self.flags(toolsets=[], read_only=False, tools=[], exclude_tools=[]), [])

    def test_a_wrong_type_is_refused(self) -> None:
        for config in (
            {"toolsets": "things"},
            {"toolsets": 3},
            {"read_only": "true"},
            {"tools": "demo_thing_read"},
            {"exclude_tools": [1]},
        ):
            with self.subTest(config=config), self.assertRaises(settings.SettingsError):
                self.flags(**config)


class OptionFlagsTest(unittest.TestCase):
    def flags(self, **config: Any) -> list[str]:
        return settings.settings_flags(StubContext(config))

    def test_the_options_are_those_of_the_project(self) -> None:
        self.assertEqual(project.OPTIONS, ("published_text_rules", "worktree_root"))

    def test_the_worktree_root_becomes_its_flag(self) -> None:
        self.assertEqual(self.flags(worktree_root=" ~/trees "), ["--worktree-root", "~/trees"])
        self.assertEqual(self.flags(worktree_root=" "), [])

    def test_an_option_becomes_its_flag_after_the_other_settings(self) -> None:
        self.assertEqual(
            self.flags(published_text_rules="/etc/rules.json", read_only=True),
            ["--read-only", "--published-text-rules", "/etc/rules.json"],
        )

    def test_the_option_is_stripped(self) -> None:
        self.assertEqual(
            self.flags(published_text_rules=" /etc/rules.json \n"), ["--published-text-rules", "/etc/rules.json"]
        )

    def test_absent_and_blank_options_give_no_flag(self) -> None:
        for config in ({}, {"published_text_rules": None}, {"published_text_rules": ""}, {"published_text_rules": " \t"}):
            with self.subTest(config=config):
                self.assertEqual(self.flags(**config), [])

    def test_an_option_that_is_not_text_is_refused(self) -> None:
        for value in (3, True, ["/etc/rules.json"], {"path": "/etc/rules.json"}):
            with self.subTest(value=value), self.assertRaises(settings.SettingsError):
                self.flags(published_text_rules=value)

    def test_option_flags_are_the_option_part_alone(self) -> None:
        ctx = StubContext({"published_text_rules": "/etc/rules.json", "read_only": True, "tools": ["demo_thing_read"]})
        self.assertEqual(settings.option_flags(ctx), ["--published-text-rules", "/etc/rules.json"])


class LanguageSettingTest(unittest.TestCase):
    def language(self, **config: Any) -> str | None:
        return settings.language_setting(StubContext(config))

    def test_a_language_is_read_stripped(self) -> None:
        self.assertEqual(self.language(language="ja"), "ja")
        self.assertEqual(self.language(language="  ja-JP \n"), "ja-JP")

    def test_absent_blank_and_non_string_values_are_unset(self) -> None:
        for config in ({}, {"language": ""}, {"language": " \t"}, {"language": None}, {"language": 3}, {"language": ["ja"]}):
            with self.subTest(config=config):
                self.assertIsNone(self.language(**config))

    def test_it_is_no_flag_of_list_or_run(self) -> None:
        self.assertEqual(settings.settings_flags(StubContext({"language": "ja"})), [])


class EmojiSettingTest(unittest.TestCase):
    def test_no_setting_returns_a_copy_of_the_package_defaults(self) -> None:
        for defaults in ({}, {"things": "🧩", "widgets": "🔀"}):
            with self.subTest(defaults=defaults), mock.patch.object(project, "TOOLSET_EMOJI", defaults):
                result = settings.emoji_setting(StubContext())
                self.assertEqual(result, defaults)
                self.assertIsNot(result, defaults)

    def test_explicit_defaults_are_copied(self) -> None:
        defaults = {"things": "🧩", "widgets": "🔀"}
        result = settings.emoji_setting(StubContext(), defaults=defaults)
        self.assertEqual(result, defaults)
        self.assertIsNot(result, defaults)

    def test_overrides_replace_and_add_emoji_and_preserve_other_defaults(self) -> None:
        defaults = {"things": "🧩", "widgets": "🔀"}
        result = settings.emoji_setting(StubContext({"emoji": {"things": "🗒️", "items": "📦"}}), defaults)
        self.assertEqual(result, {"things": "🗒️", "widgets": "🔀", "items": "📦"})
        self.assertEqual(defaults, {"things": "🧩", "widgets": "🔀"})

    def test_an_empty_string_removes_an_emoji(self) -> None:
        result = settings.emoji_setting(StubContext({"emoji": {"things": ""}}), {"things": "🧩", "widgets": "🔀"})
        self.assertEqual(result, {"things": "", "widgets": "🔀"})

    def test_a_setting_that_is_not_a_dict_is_ignored(self) -> None:
        defaults = {"things": "🧩", "widgets": "🔀"}
        for value in (None, "🧩", ["things"], 3, True):
            with self.subTest(value=value):
                self.assertEqual(settings.emoji_setting(StubContext({"emoji": value}), defaults), defaults)

    def test_entries_that_are_not_strings_are_ignored(self) -> None:
        defaults = {"things": "🧩", "widgets": "🔀"}
        for value in (None, 3, ["🧩"], True, {"a": "b"}):
            with self.subTest(value=value):
                result = settings.emoji_setting(StubContext({"emoji": {"things": value, "items": "📦"}}), defaults)
                self.assertEqual(result, {"things": "🧩", "widgets": "🔀", "items": "📦"})
        result = settings.emoji_setting(StubContext({"emoji": {1: "🧩", "items": "📦"}}), defaults)
        self.assertEqual(result, {"things": "🧩", "widgets": "🔀", "items": "📦"})

    def test_it_is_no_flag_of_list_or_run(self) -> None:
        self.assertEqual(settings.settings_flags(StubContext({"emoji": {"things": "🗒️"}})), [])


if __name__ == "__main__":
    unittest.main()
