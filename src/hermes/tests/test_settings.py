"""Tests of the settings the plugin turns into command-line flags."""

from __future__ import annotations

import unittest
from typing import Any

from support import StubContext, settings


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


if __name__ == "__main__":
    unittest.main()
