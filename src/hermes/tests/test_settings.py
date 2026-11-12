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
    def test_the_options_are_those_of_the_project(self) -> None:
        self.assertEqual(project.OPTIONS, {"published_text_rules": "text", "worktree_root": "text"})

    def test_each_kind_becomes_a_flag(self) -> None:
        options = {"note_text": "text", "note_pinned": "boolean", "note_count": "number", "note_tags": "list"}
        ctx = StubContext(
            {"note_text": " hello \n", "note_pinned": True, "note_count": -2.5, "note_tags": [" a ", "", " b"]}
        )
        expected = ["--note-text", "hello", "--note-pinned", "--note-count", "-2.5", "--note-tags", "a,b"]
        self.assertEqual(settings.option_flags(ctx, options), expected)
        with mock.patch.object(project, "OPTIONS", options):
            self.assertEqual(settings.settings_flags(ctx), expected)

    def test_absent_and_empty_values_give_no_flags(self) -> None:
        options = {"note_text": "text", "note_pinned": "boolean", "note_count": "number", "note_tags": "list"}
        for config in (
            {},
            {"note_text": None},
            {"note_text": " \t", "note_pinned": False, "note_tags": [" ", ""]},
            {"note_tags": []},
        ):
            with self.subTest(config=config):
                self.assertEqual(settings.option_flags(StubContext(config), options), [])

    def test_zero_is_not_absent(self) -> None:
        self.assertEqual(
            settings.option_flags(StubContext({"note_count": 0}), {"note_count": "number"}), ["--note-count", "0"]
        )

    def test_paths_are_trimmed_but_not_expanded_or_checked(self) -> None:
        options = {"notes_dir": "path", "extra_dirs": "paths"}
        ctx = StubContext({"notes_dir": " ~/notes \n", "extra_dirs": [" /notes ", "", " ", "relative"]})
        self.assertEqual(
            settings.option_flags(ctx, options), ["--notes-dir", "~/notes", "--extra-dirs", "/notes,relative"]
        )

    def test_absent_and_blank_paths_give_no_flags(self) -> None:
        options = {"notes_dir": "path", "extra_dirs": {"type": "paths", "min": 1}}
        for config in ({}, {"notes_dir": None}, {"notes_dir": " \t", "extra_dirs": ["", " "]}, {"extra_dirs": []}):
            with self.subTest(config=config):
                self.assertEqual(settings.option_flags(StubContext(config), options), [])

    def test_dict_declarations_give_the_same_flags(self) -> None:
        for kind, value, bounds in (
            ("text", " hello ", {}),
            ("boolean", True, {}),
            ("number", -2.5, {"integer": True, "min": 1, "max": 50}),
            ("list", [" a ", "b", "c"], {"min": 1, "max": 2}),
            ("path", " ~/notes ", {}),
            ("paths", [" /notes ", "relative"], {"max": 1}),
        ):
            with self.subTest(kind=kind):
                ctx = StubContext({"a_b": value})
                self.assertEqual(
                    settings.option_flags(ctx, {"a_b": {"type": kind, **bounds}}),
                    settings.option_flags(ctx, {"a_b": kind}),
                )

    def test_wrong_path_types_name_the_setting(self) -> None:
        for kind, values, expected in (
            ("path", [True, 3, []], 'setting "a_b" must be a path'),
            ("paths", ["/notes", [1], ["/a,/b"], True], 'setting "a_b" must be a list of paths without commas'),
        ):
            for value in values:
                for declaration in (kind, {"type": kind}):
                    with self.subTest(declaration=declaration, value=value):
                        with self.assertRaises(settings.SettingsError) as error:
                            settings.option_flags(StubContext({"a_b": value}), {"a_b": declaration})
                        self.assertEqual(str(error.exception), expected)

    def test_wrong_types_are_refused(self) -> None:
        for kind, values in (
            ("text", [True, 3, []]),
            ("boolean", ["true", 1, []]),
            ("number", [True, "3", [], float("nan"), float("inf"), -float("inf")]),
            ("list", ["a", [1], ["a,b"], True]),
            ("unknown", ["value"]),
        ):
            for value in values:
                with self.subTest(kind=kind, value=value), self.assertRaises(settings.SettingsError):
                    settings.option_flags(StubContext({"note_text": value}), {"note_text": kind})

    def test_option_flags_excludes_selection_and_language(self) -> None:
        ctx = StubContext({"note_text": "hello", "read_only": True, "toolsets": ["things"], "language": "ja"})
        self.assertEqual(settings.option_flags(ctx, {"note_text": "text"}), ["--note-text", "hello"])


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
