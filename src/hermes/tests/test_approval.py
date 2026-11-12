"""Tests of the hook that sends calls that write to the person's approval."""

from __future__ import annotations

import json
import re
import sys
import threading
import types
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from support import CWD, FAKE_CLI, LISTING, FakeCliCase, StubContext, approval, listing, project, runtime


CREATE = "Create a thing"
UPDATE = "Update a widget"
DETAILS = "\n\n--- Details ---\n\n"


def key(tool_id: str, *resources: str) -> str:
    """The rule_key of a call of ``tool_id`` that names ``resources``."""
    return f"{project.PLUGIN_NAME}:{tool_id}:{json.dumps(list(resources), separators=(',', ':'))}"


class SurfaceContext(StubContext):
    def session_surface(self) -> str:
        return "cli"


class ApprovalHookTest(FakeCliCase):
    def hook(self) -> Any:
        return self.register().hooks[0][1]

    def target_calls(self) -> list[dict[str, Any]]:
        return [call for call in self.calls() if call["argv"][0] == "target"]

    def test_a_write_is_sent_to_approval_with_message_and_rule_key(self) -> None:
        self.reply("target demo_thing_create", stdout='{"resources":["target/one"]}\n')
        decision = self.hook()(tool_name="demo_thing_create", args={"target": "target/one", "body": "hi"}, task_id="t")
        self.assertEqual(
            decision,
            {
                "action": "approve",
                "message": f"{CREATE}{DETAILS}Target: target/one",
                "rule_key": key("demo_thing_create", "target/one"),
            },
        )
        [call] = self.target_calls()
        self.assertEqual(call["argv"], ["target", "demo_thing_create", "--cwd", CWD])
        self.assertEqual(json.loads(call["stdin"]), {"target": "target/one", "body": "hi"})

    def test_every_non_read_class_is_sent_to_approval(self) -> None:
        for tool_id in ("demo_widget_update", "demo_item_add", "demo_gadget_edit", "demo_task_run"):
            self.reply(f"target {tool_id}", stdout='{"resources":["target/one"]}')
            with self.subTest(tool=tool_id):
                self.assertEqual(self.hook()(tool_name=tool_id, args={})["action"], "approve")

    def test_a_description_without_a_surface_uses_the_strictest_card(self) -> None:
        self.reply(
            "target demo_thing_create",
            stdout=json.dumps(
                {
                    "resources": ["target/one"],
                    "description": {
                        "headline": 'Create the thing "a_b"',
                        "facts": [{"label": "Kind", "value": "group_chat"}],
                        "text": {"label": "Note", "body": "hi @everyone"},
                    },
                }
            ),
        )
        decision = self.hook()(tool_name="demo_thing_create", args={})
        self.assertEqual(
            decision,
            {
                "action": "approve",
                "message": 'Create the thing "a\\_b"'
                f"{DETAILS}Target: target/one\nKind: group\\_chat\n\n--- Note ---\n\nhi \\@everyone",
                "rule_key": key("demo_thing_create", "target/one"),
            },
        )
        self.assertEqual(len(self.target_calls()), 1)

    def test_a_description_is_fitted_to_the_session_surface(self) -> None:
        self.reply(
            "target demo_thing_create",
            stdout=json.dumps(
                {
                    "resources": ["target/one"],
                    "description": {
                        "facts": [{"label": "Kind", "value": "group_chat"}],
                        "text": {"label": "Note", "body": "hi <@everyone> & all"},
                    },
                }
            ),
        )
        for surface, text in (("cli", "hi <@everyone> & all"), ("slack", "hi &lt;@everyone&gt; &amp; all")):
            with self.subTest(surface=surface), mock.patch.object(SurfaceContext, "session_surface", return_value=surface):
                ctx = self.register(ctx=SurfaceContext())
                decision = ctx.hooks[0][1](tool_name="demo_thing_create", args={})
                self.assertEqual(
                    decision["message"],
                    f"{CREATE}{DETAILS}Target: target/one\nKind: group_chat\n\n--- Note ---\n\n{text}",
                )
                self.assertEqual(decision["rule_key"], key("demo_thing_create", "target/one"))

    def test_an_unavailable_surface_still_approves_with_the_strictest_card(self) -> None:
        self.reply(
            "target demo_thing_create",
            stdout=json.dumps(
                {
                    "resources": ["target/one"],
                    "description": {"facts": [], "text": {"label": "Note", "body": "hi <@everyone> & all"}},
                }
            ),
        )
        for fields in (
            {"side_effect": RuntimeError("unavailable")},
            {"return_value": None},
            {"return_value": 3},
            {"return_value": ""},
        ):
            with self.subTest(fields=fields), mock.patch.object(SurfaceContext, "session_surface", **fields):
                ctx = self.register(ctx=SurfaceContext())
                decision = ctx.hooks[0][1](tool_name="demo_thing_create", args={})
                self.assertEqual(decision["action"], "approve")
                self.assertEqual(
                    decision["message"],
                    f"{CREATE}{DETAILS}Target: target/one\n\n--- Note ---\n\nhi &lt;\\@everyone&gt; &amp; all",
                )

    def test_the_surface_is_read_even_without_a_description(self) -> None:
        self.reply("target demo_thing_create", stdout='{"resources":["target/one"]}')
        with mock.patch.object(SurfaceContext, "session_surface", return_value="slack") as surface:
            ctx = self.register(ctx=SurfaceContext())
            decision = ctx.hooks[0][1](tool_name="demo_thing_create", args={})
            self.assertEqual(decision["message"], f"{CREATE}{DETAILS}Target: target/one")
            surface.assert_called_once_with()

    def test_a_bad_description_preserves_the_message_and_resources(self) -> None:
        for description in (
            "x",
            {"facts": "x"},
            {"facts": [{"label": "", "value": "v"}]},
            {"facts": [], "text": 5},
            {"facts": [{"label": "a", "value": "b"}], "text": {"label": "Note"}},
        ):
            self.reply(
                "target demo_thing_create", stdout=json.dumps({"resources": ["target/one"], "description": description})
            )
            with self.subTest(description=description):
                decision = self.hook()(tool_name="demo_thing_create", args={})
                self.assertEqual(decision["message"], f"{CREATE}{DETAILS}Target: target/one")
                self.assertEqual(decision["rule_key"], key("demo_thing_create", "target/one"))

    def test_a_description_with_unresolved_resources_keeps_the_single_use_key(self) -> None:
        self.reply(
            "target demo_widget_update",
            stdout=json.dumps(
                {"resources": ["*"], "description": {"facts": [], "text": {"label": "Note", "body": "hi @everyone"}}}
            ),
        )
        decision = self.assert_single_use("demo_widget_update", key("demo_widget_update", "*"), args={})
        self.assertEqual(decision["message"], f"{UPDATE}\n\n--- Note ---\n\nhi \\@everyone")

    def test_control_characters_in_a_description_are_marked(self) -> None:
        self.reply(
            "target demo_thing_create",
            stdout=json.dumps(
                {"resources": ["target/one"], "description": {"facts": [{"label": "Name", "value": "a\u202eb"}]}}
            ),
        )
        ctx = self.register(ctx=SurfaceContext())
        decision = ctx.hooks[0][1](tool_name="demo_thing_create", args={})
        self.assertEqual(decision["message"], f"{CREATE}{DETAILS}Target: target/one\nName: a<U+202E>b")

    def test_invalid_resources_do_not_discard_a_description(self) -> None:
        self.reply(
            "target demo_widget_update",
            stdout=json.dumps(
                {"resources": [], "description": {"facts": [], "text": {"label": "Note", "body": "hi"}}}
            ),
        )
        decision = self.assert_single_use("demo_widget_update", key("demo_widget_update", "*"), args={})
        self.assertEqual(decision["message"], f"{UPDATE}\n\n--- Note ---\n\nhi")

    def test_a_failed_target_does_not_show_its_description(self) -> None:
        self.reply(
            "target demo_widget_update",
            code=1,
            stdout=json.dumps(
                {"resources": ["target/one"], "description": {"facts": [], "text": {"label": "Note", "body": "hi"}}}
            ),
        )
        decision = self.assert_single_use("demo_widget_update", key("demo_widget_update", "*"), args={})
        self.assertEqual(decision["message"], UPDATE)

    def test_a_card_that_cannot_be_built_still_asks_with_the_card_without_a_description(self) -> None:
        self.reply(
            "target demo_thing_create",
            stdout=json.dumps(
                {"resources": ["target/one"], "description": {"facts": [], "text": {"label": "Note", "body": "hi"}}}
            ),
        )
        hook = self.hook()
        build = approval.card.build_message
        built: list[Any] = []

        def failing_with_a_description(
            title: str, resources: list[str], description: Any, surface: Any, words: Any
        ) -> str:
            built.append((description is None, surface))
            if description is not None:
                raise RuntimeError("boom")
            return build(title, resources, description, surface, words)

        with mock.patch.object(approval.card, "build_message", side_effect=failing_with_a_description):
            decision = hook(tool_name="demo_thing_create", args={})
        self.assertEqual(
            decision,
            {
                "action": "approve",
                "message": f"{CREATE}{DETAILS}Target: target/one",
                "rule_key": key("demo_thing_create", "target/one"),
            },
        )
        self.assertEqual(built, [(False, None), (True, None)])

    def test_a_card_that_cannot_be_built_at_all_still_asks_with_the_title(self) -> None:
        self.reply("target demo_thing_create", stdout='{"resources":["target/one"]}')
        hook = self.hook()
        with mock.patch.object(approval.card, "build_message", side_effect=RuntimeError("boom")):
            decision = hook(tool_name="demo_thing_create", args={})
        self.assertEqual(
            decision,
            {
                "action": "approve",
                "message": CREATE,
                "rule_key": key("demo_thing_create", "target/one"),
            },
        )

    def test_a_read_is_left_alone_without_asking_the_cli(self) -> None:
        self.assertIsNone(self.hook()(tool_name="demo_thing_read", args={}))
        self.assertEqual(self.target_calls(), [])

    def test_a_tool_of_another_plugin_is_left_alone(self) -> None:
        self.assertIsNone(self.hook()(tool_name="write_file", args={"path": "/tmp/x"}))
        self.assertEqual(self.target_calls(), [])

    def test_every_resource_a_write_names_is_in_the_message_and_the_rule_key(self) -> None:
        self.reply("target demo_thing_create", stdout='{"resources":["target/one","target/two"]}')
        decision = self.hook()(tool_name="demo_thing_create", args={"target": "target/two", "body": "hi"})
        self.assertEqual(decision["message"], f"{CREATE}{DETAILS}Target: target/one\nTarget: target/two")
        self.assertEqual(decision["rule_key"], key("demo_thing_create", "target/one", "target/two"))

    def test_resources_with_a_comma_never_share_a_rule_key_with_a_longer_list(self) -> None:
        hook = self.hook()
        self.reply("target demo_thing_create", stdout='{"resources":["a,b"]}')
        joined = hook(tool_name="demo_thing_create", args={})["rule_key"]
        self.reply("target demo_thing_create", stdout='{"resources":["a","b"]}')
        split = hook(tool_name="demo_thing_create", args={})["rule_key"]
        self.assertNotEqual(joined, split)

    def assert_single_use(self, tool_id: str, key_prefix: str, **call: Any) -> dict[str, str]:
        """The decision's rule_key is the prefix plus a token no other call shares, so an "always" reuses nothing."""
        hook = self.hook()
        first = hook(tool_name=tool_id, **call)
        second = hook(tool_name=tool_id, **call)
        for decision in (first, second):
            self.assertRegex(decision["rule_key"], rf"^{re.escape(key_prefix)}:once-[0-9a-f]{{32}}$")
        self.assertNotEqual(first["rule_key"], second["rule_key"])
        return first

    def test_an_unresolved_target_is_any_resource_and_leaves_nothing_to_reuse(self) -> None:
        self.reply("target demo_widget_update", stdout='{"resources":["*"]}')
        decision = self.assert_single_use("demo_widget_update", key("demo_widget_update", "*"), args={})
        self.assertEqual(decision["message"], UPDATE)

    def test_a_resource_that_cannot_be_told_stays_beside_the_others_and_leaves_nothing_to_reuse(self) -> None:
        self.reply("target demo_widget_update", stdout='{"resources":["target/one","*"]}')
        decision = self.assert_single_use("demo_widget_update", key("demo_widget_update", "target/one", "*"), args={})
        self.assertEqual(decision["message"], f"{UPDATE}{DETAILS}Target: target/one\nTarget: \\*")

    def test_a_rule_key_that_names_only_known_resources_is_stable(self) -> None:
        self.reply("target demo_thing_create", stdout='{"resources":["target/one"]}')
        hook = self.hook()
        keys = {hook(tool_name="demo_thing_create", args={})["rule_key"] for _ in range(2)}
        self.assertEqual(keys, {key("demo_thing_create", "target/one")})

    def test_a_failing_target_falls_back_to_any_resource(self) -> None:
        for fields in (
            {"code": 1, "stdout": '{"error":{"code":"invalid_argument","message":"x"}}'},
            {"code": 2, "stderr": "usage"},
            {"code": 0, "stdout": "not json"},
            {"code": 0, "stdout": "[]"},
            {"code": 0, "stdout": '{"resources": "target/one"}'},
            {"code": 0, "stdout": '{"resources": []}'},
            {"code": 0, "stdout": '{"resources": [3]}'},
            {"code": 0, "stdout": '{"resources": ["target/one", ""]}'},
            {"code": 0, "stdout": '{"resource": "target/one"}'},
        ):
            self.reply("target demo_widget_update", **fields)
            with self.subTest(fields=fields):
                self.assert_single_use("demo_widget_update", key("demo_widget_update", "*"), args={})

    def test_a_target_that_times_out_or_cannot_start_falls_back_to_any_resource(self) -> None:
        self.reply("target demo_widget_update", sleep=5, stdout='{"resources":["target/one"]}')
        hook = self.hook()
        with mock.patch.object(approval, "TARGET_TIMEOUT_SECONDS", 0.3):
            decision = hook(tool_name="demo_widget_update", args={})
        self.assertRegex(decision["rule_key"], rf"^{re.escape(key('demo_widget_update', '*'))}:once-[0-9a-f]{{32}}$")
        broken = runtime.Runtime(
            node=str(self.dir / "no-node"), cli=FAKE_CLI, skills_dir=self.skills_dir, find_node=lambda: None
        )
        tool = listing.ToolInfo.from_listing(LISTING[2])
        decision = approval.make_hook(broken, [tool])(tool_name="demo_widget_update", args={})
        self.assertRegex(decision["rule_key"], rf"^{re.escape(key('demo_widget_update', '*'))}:once-[0-9a-f]{{32}}$")

    def test_arguments_that_are_not_a_dict_still_ask(self) -> None:
        self.reply("target demo_widget_update", stdout='{"resources":["target/one"]}')
        decision = self.hook()(tool_name="demo_widget_update", args=None)
        self.assertEqual(decision["action"], "approve")
        self.assertEqual(json.loads(self.target_calls()[0]["stdin"]), {})

    def test_it_does_not_look_for_a_person_itself(self) -> None:
        self.reply("target demo_widget_update", stdout='{"resources":["target/one"]}')
        with mock.patch.dict("os.environ", {"HERMES_CRON": "1", "HERMES_YOLO_MODE": "1"}):
            self.assertEqual(self.hook()(tool_name="demo_widget_update", args={})["action"], "approve")


class ApprovalLanguageTest(FakeCliCase):
    def target_calls(self) -> list[dict[str, Any]]:
        return [call for call in self.calls() if call["argv"][0] == "target"]

    def target_argv(self) -> list[str]:
        [call] = self.target_calls()
        return call["argv"]

    def ask(self, config: dict[str, Any] | None = None, display: Any = None) -> tuple[dict[str, str], list[str]]:
        """The decision of one call and the argv ``target`` ran with, the display language being ``display``."""
        self.reply("target demo_thing_create", stdout='{"resources":["target/one"]}')
        with mock.patch.object(approval, "display_language", **display or {"return_value": None}):
            hook = self.register(config).hooks[0][1]
            decision = hook(tool_name="demo_thing_create", args={})
        return decision, self.target_argv()

    def test_the_setting_and_the_display_language_become_flags_in_a_stable_order(self) -> None:
        base = ["target", "demo_thing_create", "--cwd", CWD]
        for config, display, flags in (
            ({}, None, []),
            ({"language": "ja"}, None, ["--language=ja"]),
            ({}, "fr", ["--harness-language=fr"]),
            ({"language": " de "}, "fr", ["--language=de", "--harness-language=fr"]),
            ({"language": "  "}, " fr ", ["--harness-language=fr"]),
            ({"language": 3}, None, []),
            ({"language": "--tools"}, None, ["--language=--tools"]),
        ):
            with self.subTest(config=config, display=display):
                self.log.unlink(missing_ok=True)
                _, argv = self.ask(config, {"return_value": display})
                self.assertEqual(argv, [*base, *flags])

    def test_the_display_language_is_read_on_every_call(self) -> None:
        self.reply("target demo_thing_create", stdout='{"resources":["target/one"]}')
        hook = self.register().hooks[0][1]
        for display in ("ja", "fr"):
            with mock.patch.object(approval, "display_language", return_value=display):
                hook(tool_name="demo_thing_create", args={})
        argvs = [call["argv"] for call in self.target_calls()]
        self.assertEqual([argv[4:] for argv in argvs], [["--harness-language=ja"], ["--harness-language=fr"]])

    def test_a_display_language_that_fails_or_is_junk_gives_no_flag_and_the_card_is_built(self) -> None:
        for fields in (
            {"side_effect": RuntimeError("no i18n")},
            {"return_value": None},
            {"return_value": ""},
            {"return_value": "   "},
            {"return_value": 3},
            {"return_value": ["ja"]},
        ):
            with self.subTest(fields=fields):
                self.log.unlink(missing_ok=True)
                decision, argv = self.ask({"language": "ja"}, fields)
                self.assertEqual(argv, ["target", "demo_thing_create", "--cwd", CWD, "--language=ja"])
                self.assertEqual(decision["message"], f"{CREATE}{DETAILS}Target: target/one")
                self.assertEqual(decision["rule_key"], key("demo_thing_create", "target/one"))

    def test_an_injected_reader_that_fails_or_is_junk_knows_nothing(self) -> None:
        self.reply("target demo_thing_create", stdout='{"resources":["target/one"]}')
        self.write_fixture()
        tool = listing.ToolInfo.from_listing(LISTING[1])

        def failing() -> str:
            raise RuntimeError("boom")

        for read in (failing, lambda: 3, lambda: " "):
            with self.subTest(read=read):
                self.log.unlink(missing_ok=True)
                decision = approval.make_hook(self.runtime, [tool], harness_language=read)(
                    tool_name="demo_thing_create", args={}
                )
                self.assertEqual(self.target_argv(), ["target", "demo_thing_create", "--cwd", CWD])
                self.assertEqual(decision["message"], f"{CREATE}{DETAILS}Target: target/one")

    def test_list_and_run_get_no_language_flag(self) -> None:
        self.reply("run demo_thing_create", stdout='{"result":{}}')
        with mock.patch.object(approval, "display_language", return_value="ja"):
            ctx = self.register({"language": "ja"})
            ctx.tools["demo_thing_create"]["handler"]({"target": "target/one"})
        for call in self.calls():
            if call["argv"][0] in ("list", "run"):
                with self.subTest(argv=call["argv"]):
                    self.assertFalse(any(arg.startswith("--language") for arg in call["argv"]))
                    self.assertFalse(any(arg.startswith("--harness-language") for arg in call["argv"]))


JAPANESE_WORDS = {
    "details": "詳細",
    "target": "対象",
    "more": "（ほか {count} 件）",
    "more_character": "（ほか {count} 文字）",
    "more_characters": "（ほか {count} 文字）",
}


class ApprovalWordsTest(FakeCliCase):
    def answer(self, **fields: Any) -> dict[str, Any]:
        """The decision for a call whose ``target`` answers its resources and description with ``fields`` added."""
        description = {"facts": [{"label": "サイズ", "value": "1 byte"}], "text": {"label": "メモの本文", "body": "x"}}
        document = {"resources": ["target/one"], "description": description, **fields}
        self.reply("target demo_thing_create", stdout=json.dumps(document, ensure_ascii=False))
        ctx = self.register(ctx=SurfaceContext())
        return ctx.hooks[0][1](tool_name="demo_thing_create", args={})

    def test_the_title_and_the_words_of_the_answer_draw_the_card(self) -> None:
        decision = self.answer(title="メモを作成する", words=JAPANESE_WORDS)
        self.assertEqual(
            decision,
            {
                "action": "approve",
                "message": "メモを作成する\n\n--- 詳細 ---\n\n対象: target/one\nサイズ: 1 byte\n\n--- メモの本文 ---\n\nx",
                "rule_key": key("demo_thing_create", "target/one"),
            },
        )

    def test_the_characters_a_cut_left_out_are_counted_in_the_words_of_the_answer(self) -> None:
        description = {
            "facts": [{"label": "サイズ", "value": "1 byte…", "omitted": 1}],
            "text": {"label": "メモの本文", "body": "x…", "omitted": 12},
        }
        self.assertEqual(
            self.answer(description=description, words=JAPANESE_WORDS)["message"],
            f"{CREATE}\n\n--- 詳細 ---\n\n対象: target/one\nサイズ: 1 byte… （ほか 1 文字）"
            "\n\n--- メモの本文 ---\n\nx…\n（ほか 12 文字）",
        )
        self.assertEqual(
            self.answer(description=description)["message"],
            f"{CREATE}{DETAILS}Target: target/one\nサイズ: 1 byte… (+1 more character)"
            "\n\n--- メモの本文 ---\n\nx…\n(+12 more characters)",
        )

    def test_without_a_title_or_words_the_card_is_the_english_one(self) -> None:
        decision = self.answer()
        self.assertEqual(
            decision["message"], f"{CREATE}{DETAILS}Target: target/one\nサイズ: 1 byte\n\n--- メモの本文 ---\n\nx"
        )

    def test_words_are_used_beside_the_registered_title_and_a_title_beside_english_words(self) -> None:
        self.assertEqual(
            self.answer(words=JAPANESE_WORDS)["message"],
            f"{CREATE}\n\n--- 詳細 ---\n\n対象: target/one\nサイズ: 1 byte\n\n--- メモの本文 ---\n\nx",
        )
        self.assertEqual(
            self.answer(title="メモを作成する")["message"],
            "メモを作成する" + f"{DETAILS}Target: target/one\nサイズ: 1 byte\n\n--- メモの本文 ---\n\nx",
        )

    def test_a_bad_title_is_the_registered_one_and_changes_nothing_else(self) -> None:
        for title in (None, "", "  ", 3, ["t"], {"t": 1}):
            with self.subTest(title=title):
                decision = self.answer(title=title, words=JAPANESE_WORDS)
                self.assertEqual(
                    decision["message"],
                    f"{CREATE}\n\n--- 詳細 ---\n\n対象: target/one\nサイズ: 1 byte\n\n--- メモの本文 ---\n\nx",
                )
                self.assertEqual(decision["rule_key"], key("demo_thing_create", "target/one"))

    def test_bad_words_are_the_english_ones_and_change_neither_the_title_nor_the_description_nor_the_resources(self) -> None:
        good = JAPANESE_WORDS
        for words in (
            "words",
            [],
            {},
            {"details": "詳細", "target": "対象"},
            {"target": "対象", "more": good["more"]},
            {"details": "詳細", "more": good["more"]},
            {**good, "details": ""},
            {**good, "target": " "},
            {**good, "more": ""},
            {**good, "details": 3},
            {**good, "more": "（ほか 件）"},
            {**good, "more": "{count} {count}"},
            {**good, "more": "{count} {x}"},
            {**good, "more": "{count} }"},
            {**good, "more": ["{count}"]},
        ):
            with self.subTest(words=words):
                decision = self.answer(title="メモを作成する", words=words)
                self.assertEqual(
                    decision["message"],
                    "メモを作成する" + f"{DETAILS}Target: target/one\nサイズ: 1 byte\n\n--- メモの本文 ---\n\nx",
                )
                self.assertEqual(decision["rule_key"], key("demo_thing_create", "target/one"))

    def test_words_and_title_survive_resources_that_cannot_be_told(self) -> None:
        decision = self.answer(resources=[], title="メモを作成する", words=JAPANESE_WORDS)
        self.assertRegex(decision["rule_key"], r":once-[0-9a-f]{32}$")
        self.assertEqual(decision["message"], "メモを作成する\n\n--- 詳細 ---\n\nサイズ: 1 byte\n\n--- メモの本文 ---\n\nx")

    def test_the_card_that_falls_back_keeps_the_title_and_the_words(self) -> None:
        self.reply(
            "target demo_thing_create",
            stdout=json.dumps(
                {
                    "resources": ["target/one"],
                    "title": "メモを作成する",
                    "words": JAPANESE_WORDS,
                    "description": {"facts": [{"label": "a", "value": "b"}]},
                },
                ensure_ascii=False,
            ),
        )
        hook = self.register().hooks[0][1]
        build = approval.card.build_message

        def failing_with_a_description(*args: Any) -> str:
            if args[2] is not None:
                raise RuntimeError("boom")
            return build(*args)

        with mock.patch.object(approval.card, "build_message", side_effect=failing_with_a_description):
            decision = hook(tool_name="demo_thing_create", args={})
        self.assertEqual(decision["message"], "メモを作成する\n\n--- 詳細 ---\n\n対象: target/one")
        with mock.patch.object(approval.card, "build_message", side_effect=RuntimeError("boom")):
            decision = hook(tool_name="demo_thing_create", args={})
        self.assertEqual(decision["message"], "メモを作成する")

    def test_a_failed_target_is_the_registered_title_in_english(self) -> None:
        self.reply("target demo_thing_create", code=1, stdout=json.dumps({"title": "メモを作成する", "words": JAPANESE_WORDS}))
        decision = self.register().hooks[0][1](tool_name="demo_thing_create", args={})
        self.assertEqual(decision["message"], CREATE)


LISTED_INTENT = "About to create a thing"
TARGET_INTENT = "About to create the thing target one"
TARGET_TITLE = "Create the thing target one"


class ApprovalIntentTest(FakeCliCase):
    def decide(self, listed_intent: Any = LISTED_INTENT, code: int = 0, **fields: Any) -> dict[str, str]:
        """The decision for a call of ``demo_thing_create``, listed with ``listed_intent`` and answered with ``fields``."""
        entries = [
            {**entry, "intent": listed_intent} if entry["id"] == "demo_thing_create" else entry for entry in LISTING
        ]
        self.reply("list", stdout=json.dumps(entries))
        self.reply("target demo_thing_create", code=code, stdout=json.dumps({"resources": ["target/one"], **fields}))
        return self.register().hooks[0][1](tool_name="demo_thing_create", args={})

    def assert_card(self, decision: dict[str, str], line: str) -> None:
        self.assertEqual(
            decision,
            {
                "action": "approve",
                "message": f"{line}{DETAILS}Target: target/one",
                "rule_key": key("demo_thing_create", "target/one"),
            },
        )

    def test_the_translated_intent_of_the_answer_comes_first(self) -> None:
        self.assert_card(self.decide(title=TARGET_TITLE, intent=TARGET_INTENT), TARGET_INTENT)

    def test_without_an_intent_in_the_answer_the_translated_title_comes_next(self) -> None:
        self.assert_card(self.decide(title=TARGET_TITLE), TARGET_TITLE)

    def test_a_failing_target_falls_to_the_listed_intent(self) -> None:
        decision = self.decide(code=1, title=TARGET_TITLE, intent=TARGET_INTENT)
        self.assertEqual(decision["message"], LISTED_INTENT)
        self.assertRegex(decision["rule_key"], r":once-[0-9a-f]{32}$")

    def test_a_target_without_title_or_intent_falls_to_the_listed_intent(self) -> None:
        self.assert_card(self.decide(), LISTED_INTENT)

    def test_with_no_intent_anywhere_the_listed_title_is_the_line(self) -> None:
        for listed in (None, "", "  ", 3):
            with self.subTest(listed=listed):
                self.assert_card(self.decide(listed_intent=listed), CREATE)

    def test_a_bad_intent_in_the_answer_falls_through_to_the_next_source(self) -> None:
        for intent in (None, "", "  ", 3, ["i"], {"i": 1}):
            with self.subTest(intent=intent):
                self.assert_card(self.decide(title=TARGET_TITLE, intent=intent), TARGET_TITLE)
                self.assert_card(self.decide(intent=intent), LISTED_INTENT)

    def test_the_last_resort_card_is_the_line_alone(self) -> None:
        self.reply("target demo_thing_create", stdout=json.dumps({"resources": ["target/one"], "title": TARGET_TITLE}))
        self.reply("list", stdout=json.dumps([{**LISTING[1], "intent": LISTED_INTENT}]))
        hook = self.register().hooks[0][1]
        with mock.patch.object(approval.card, "build_message", side_effect=RuntimeError("boom")):
            self.assertEqual(hook(tool_name="demo_thing_create", args={})["message"], TARGET_TITLE)
        self.reply("target demo_thing_create", stdout=json.dumps({"resources": ["target/one"]}))
        self.write_fixture()
        with mock.patch.object(approval.card, "build_message", side_effect=RuntimeError("boom")):
            self.assertEqual(hook(tool_name="demo_thing_create", args={})["message"], LISTED_INTENT)

    def test_a_headline_is_still_shown_with_the_intent_standing_by(self) -> None:
        description = {"headline": "Create the thing x", "facts": [{"label": "Size", "value": "1"}]}
        decision = self.decide(intent=TARGET_INTENT, description=description)
        self.assertEqual(decision["message"], f"Create the thing x{DETAILS}Target: target/one\nSize: 1")


PIN = "0f" * 32
OTHER_PIN = "a1" * 32
MODIFY_EMPTY = {"action": "modify", "args": {approval.PIN_ARGUMENT: ""}}


class ApprovalPinTest(FakeCliCase):
    def answer(self, **fields: Any) -> None:
        self.reply("target demo_thing_create", stdout=json.dumps({"resources": ["target/one"], **fields}))
        self.write_fixture()

    def hooks(self) -> tuple[Any, Any]:
        ctx = self.register()
        return ctx.hooks[0][1], ctx.hooks[1][1]

    def decide(self, pins: Any, **call: Any) -> dict[str, str]:
        tool = listing.ToolInfo.from_listing(LISTING[1])
        return approval.make_hook(self.runtime, [tool], pins=pins)(tool_name="demo_thing_create", args={}, **call)

    def test_the_pin_of_the_answer_is_parsed(self) -> None:
        for pin, expected in (
            (PIN, PIN),
            (PIN.upper(), None),
            (PIN[:-1], None),
            (PIN + "0", None),
            ("", None),
            (5, None),
            (None, None),
            ([PIN], None),
        ):
            with self.subTest(pin=pin):
                self.answer(pin=pin)
                self.assertEqual(approval.resolve_target(self.runtime, "demo_thing_create", {}).pin, expected)

    def test_an_answer_without_a_pin_has_none(self) -> None:
        self.answer()
        self.assertIsNone(approval.resolve_target(self.runtime, "demo_thing_create", {}).pin)

    def test_the_pin_of_a_failed_target_is_none(self) -> None:
        self.reply("target demo_thing_create", code=1, stdout=json.dumps({"resources": ["a"], "pin": PIN}))
        self.write_fixture()
        self.assertIsNone(approval.resolve_target(self.runtime, "demo_thing_create", {}).pin)

    def test_the_approval_hook_stashes_a_pin_and_decides_the_same_without_one(self) -> None:
        self.answer(pin=PIN)
        stash = approval.PinStash()
        with_pin = self.decide(stash, tool_call_id="call-1")
        self.assertEqual(stash.take(("", "", "call-1")), PIN)
        self.answer()
        without_pin = self.decide(stash, tool_call_id="call-1")
        self.assertIsNone(stash.take(("", "", "call-1")))
        self.assertEqual(with_pin, without_pin)
        self.assertEqual(set(with_pin), {"action", "message", "rule_key"})

    def test_an_approval_without_a_pin_clears_one_left_under_its_call_id(self) -> None:
        self.answer(pin=PIN)
        stash = approval.PinStash()
        self.decide(stash, tool_call_id="call-1")
        self.answer()
        self.decide(stash, tool_call_id="call-1")
        self.assertIsNone(stash.take(("", "", "call-1")))

    def test_the_approval_hook_stashes_nothing_without_a_usable_call_id(self) -> None:
        self.answer(pin=PIN)
        stash = approval.PinStash(limit=1)
        stash.put(("", "", "sentinel"), PIN)
        for call in ({}, {"tool_call_id": ""}, {"tool_call_id": "  "}, {"tool_call_id": None}, {"tool_call_id": 4}):
            with self.subTest(call=call):
                self.assertEqual(self.decide(stash, task_id="t", session_id="s", **call)["action"], "approve")
        self.assertEqual(stash.take(("", "", "sentinel")), PIN)

    def test_the_key_of_a_call_reads_its_task_session_and_call_ids(self) -> None:
        self.assertEqual(approval.pin_key({"task_id": "t", "session_id": "s", "tool_call_id": "c"}), ("t", "s", "c"))
        self.assertEqual(approval.pin_key({"task_id": " t ", "tool_call_id": " c "}), ("t", "", "c"))
        for blank in ("", "  ", None, 3, ["t"]):
            with self.subTest(blank=blank):
                call = {"task_id": blank, "session_id": blank, "tool_call_id": "c"}
                self.assertEqual(approval.pin_key(call), ("", "", "c"))
                self.assertIsNone(approval.pin_key({"task_id": "t", "session_id": "s", "tool_call_id": blank}))

    def test_the_pin_hook_gives_the_pin_once_then_empty(self) -> None:
        self.answer(pin=PIN)
        approve, pin_hook = self.hooks()
        approve(tool_name="demo_thing_create", args={}, tool_call_id="c1")
        call = {"tool_name": "demo_thing_create", "args": {}, "tool_call_id": "c1"}
        self.assertEqual(pin_hook(**call), {"action": "modify", "args": {approval.PIN_ARGUMENT: PIN}})
        self.assertEqual(pin_hook(**call), MODIFY_EMPTY)

    def test_the_pin_hook_overwrites_a_value_the_model_sent(self) -> None:
        _, pin_hook = self.hooks()
        result = pin_hook(tool_name="demo_thing_create", args={approval.PIN_ARGUMENT: PIN}, tool_call_id="c1")
        self.assertEqual(result, MODIFY_EMPTY)

    def test_the_arguments_that_run_leave_out_the_pin_argument(self) -> None:
        args = {"target": "target/one", approval.PIN_ARGUMENT: PIN}
        self.assertEqual(approval.run_arguments(args), {"target": "target/one"})
        self.assertIn(approval.PIN_ARGUMENT, args)
        for junk in (None, [], "x", 3):
            with self.subTest(junk=junk):
                self.assertEqual(approval.run_arguments(junk), {})

    def test_the_approval_describes_the_arguments_without_a_pin_argument_the_model_sent(self) -> None:
        self.answer(pin=PIN)
        approve, _ = self.hooks()
        for value in ("", PIN, None):
            with self.subTest(value=value):
                self.log.unlink(missing_ok=True)
                args = {"target": "target/one", approval.PIN_ARGUMENT: value}
                approve(tool_name="demo_thing_create", args=args, tool_call_id="c1")
                [call] = [call for call in self.calls() if call["argv"][0] == "target"]
                self.assertEqual(json.loads(call["stdin"]), {"target": "target/one"})

    def test_a_pin_argument_the_model_sent_runs_only_what_the_card_described(self) -> None:
        self.answer(pin=PIN)
        self.reply("run demo_thing_create", stdout='{"result":{}}')
        ctx = self.register()
        approve, pin_hook = ctx.hooks[0][1], ctx.hooks[1][1]
        args = {"target": "target/one", approval.PIN_ARGUMENT: ""}
        call = {"tool_name": "demo_thing_create", "args": args, "tool_call_id": "c1"}
        self.assertEqual(approve(**call)["message"], f"{CREATE}{DETAILS}Target: target/one")
        ctx.tools["demo_thing_create"]["handler"]({**args, **pin_hook(**call)["args"]})
        calls = self.calls()
        [described] = [call for call in calls if call["argv"][0] == "target"]
        [ran] = [call for call in calls if call["argv"][0] == "run"]
        self.assertEqual(json.loads(ran["stdin"]), json.loads(described["stdin"]))
        self.assertEqual(ran["argv"][-1], f"--pin={PIN}")

    def test_the_pin_hook_gives_empty_for_a_missing_call_id(self) -> None:
        _, pin_hook = self.hooks()
        for call in ({}, {"tool_call_id": ""}, {"tool_call_id": None}, {"tool_call_id": 3}):
            with self.subTest(call=call):
                self.assertEqual(pin_hook(tool_name="demo_widget_update", args={}, **call), MODIFY_EMPTY)

    def test_the_pin_hook_leaves_reads_and_other_tools_alone(self) -> None:
        _, pin_hook = self.hooks()
        self.assertIsNone(pin_hook(tool_name="demo_thing_read", args={}, tool_call_id="c1"))
        self.assertIsNone(pin_hook(tool_name="write_file", args={}, tool_call_id="c1"))

    def test_the_pin_hook_never_raises(self) -> None:
        tool = listing.ToolInfo.from_listing(LISTING[1])

        class Broken(approval.PinStash):
            def take(self, key: approval.PinKey) -> str | None:
                raise RuntimeError("boom")

        result = approval.make_pin_hook([tool], Broken())(tool_name="demo_thing_create", args={}, tool_call_id="c1")
        self.assertEqual(result, MODIFY_EMPTY)

    def test_the_stash_drops_the_oldest_beyond_its_limit(self) -> None:
        stash = approval.PinStash(limit=2)
        for call_id in ("a", "b", "c"):
            stash.put(("t", "s", call_id), call_id * 64)
        self.assertIsNone(stash.take(("t", "s", "a")))
        self.assertEqual(stash.take(("t", "s", "b")), "b" * 64)
        self.assertEqual(stash.take(("t", "s", "c")), "c" * 64)
        self.assertEqual(approval.PIN_STASH_LIMIT, 256)

    def test_the_stash_keeps_the_same_call_id_apart_by_task_and_session(self) -> None:
        stash = approval.PinStash()
        keys = [
            ("", "session-a", "call_0"),
            ("", "session-b", "call_0"),
            ("task-a", "", "call_0"),
            ("task-b", "", "call_0"),
        ]
        for index, key in enumerate(keys):
            stash.put(key, str(index) * 64)
        for index, key in enumerate(keys):
            with self.subTest(key=key):
                self.assertEqual(stash.take(key), str(index) * 64)
                self.assertIsNone(stash.take(key))

    def test_each_session_gets_its_own_pin_through_the_hooks(self) -> None:
        approve, pin_hook = self.hooks()
        self.answer(pin=PIN)
        approve(tool_name="demo_thing_create", args={}, tool_call_id="call_0", session_id="session-a")
        self.answer(pin=OTHER_PIN)
        approve(tool_name="demo_thing_create", args={}, tool_call_id="call_0", session_id="session-b")
        call = {"tool_name": "demo_thing_create", "args": {}, "tool_call_id": "call_0"}
        self.assertEqual(
            pin_hook(**call, session_id="session-a"), {"action": "modify", "args": {approval.PIN_ARGUMENT: PIN}}
        )
        self.assertEqual(
            pin_hook(**call, session_id="session-b"), {"action": "modify", "args": {approval.PIN_ARGUMENT: OTHER_PIN}}
        )

    def test_each_task_without_a_session_gets_its_own_pin_through_the_hooks(self) -> None:
        approve, pin_hook = self.hooks()
        call = {"tool_name": "demo_thing_create", "args": {}, "tool_call_id": "call_0"}
        self.answer(pin=PIN)
        approve(**call, task_id="task-a")
        self.answer(pin=OTHER_PIN)
        approve(**call, task_id="task-b")
        self.assertEqual(pin_hook(**call, task_id="task-a"), {"action": "modify", "args": {approval.PIN_ARGUMENT: PIN}})
        self.assertEqual(
            pin_hook(**call, task_id="task-b"), {"action": "modify", "args": {approval.PIN_ARGUMENT: OTHER_PIN}}
        )

    def test_the_tasks_of_one_session_get_their_own_pins(self) -> None:
        approve, pin_hook = self.hooks()
        call = {"tool_name": "demo_thing_create", "args": {}, "tool_call_id": "call_0", "session_id": "s"}
        self.answer(pin=PIN)
        approve(**call, task_id="task-a")
        self.answer(pin=OTHER_PIN)
        approve(**call, task_id="task-b")
        self.assertEqual(
            pin_hook(**call, task_id="task-b"), {"action": "modify", "args": {approval.PIN_ARGUMENT: OTHER_PIN}}
        )
        self.assertEqual(pin_hook(**call, task_id="task-a"), {"action": "modify", "args": {approval.PIN_ARGUMENT: PIN}})

    def test_a_blank_or_missing_task_or_session_id_is_none(self) -> None:
        approve, pin_hook = self.hooks()
        call = {"tool_name": "demo_thing_create", "args": {}, "tool_call_id": "c1"}
        for blank in ("", "  ", None, 3):
            with self.subTest(blank=blank):
                self.answer(pin=PIN)
                approve(**call)
                self.assertEqual(
                    pin_hook(**call, task_id=blank, session_id=blank),
                    {"action": "modify", "args": {approval.PIN_ARGUMENT: PIN}},
                )

    def test_the_stash_is_safe_across_threads(self) -> None:
        stash = approval.PinStash()
        taken: list[str | None] = []

        def work(index: int) -> None:
            for step in range(50):
                call_id = f"{index}-{step}"
                stash.put(("t", "s", call_id), PIN)
                taken.append(stash.take(("t", "s", call_id)))

        threads = [threading.Thread(target=work, args=(index,)) for index in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(taken, [PIN] * 400)


class ApprovalRefusedTest(FakeCliCase):
    def answer(self, refused: Any, **fields: Any) -> None:
        self.reply("target demo_thing_create", stdout=json.dumps({"refused": refused, **fields}))
        self.write_fixture()

    def decide(self, pins: Any = None, tool_name: str = "demo_thing_create", **call: Any) -> Any:
        tools = [listing.ToolInfo.from_listing(item) for item in LISTING]
        return approval.make_hook(self.runtime, tools, pins=pins)(tool_name=tool_name, args={}, **call)

    def test_a_refused_call_is_blocked_with_its_code_and_message(self) -> None:
        self.answer({"code": "out_of_reach", "message": "Kept out of reach."})
        self.assertEqual(self.decide(), {"action": "block", "message": "out_of_reach: Kept out of reach."})

    def test_a_refusal_carries_its_details_on_their_own_line(self) -> None:
        self.answer({"code": "out_of_reach", "message": "No.", "details": {"object": "a"}})
        self.assertEqual(self.decide(), {"action": "block", "message": 'out_of_reach: No.\n{"object":"a"}'})

    def test_a_block_clears_the_pin_stashed_for_its_call(self) -> None:
        stash = approval.PinStash()
        stash.put(("", "", "call-1"), PIN)
        stash.put(("", "", "call-2"), PIN)
        self.answer({"code": "out_of_reach", "message": "No."}, pin=OTHER_PIN)
        self.assertEqual(self.decide(stash, tool_call_id="call-1")["action"], "block")
        self.assertIsNone(stash.take(("", "", "call-1")))
        self.assertEqual(stash.take(("", "", "call-2")), PIN)

    def test_a_malformed_refusal_is_ignored(self) -> None:
        for refused in ("no", ["x"], {}, {"code": "c"}, {"message": "m"}, {"code": " ", "message": "m"},
                        {"code": "c", "message": ""}, {"code": 1, "message": "m"}):
            with self.subTest(refused=refused):
                self.answer(refused, resources=["target/one"])
                target = approval.resolve_target(self.runtime, "demo_thing_create", {})
                self.assertIsNone(target.refused)
                self.assertEqual(target.resources, ["target/one"])
                self.assertEqual(self.decide()["action"], "approve")

    def test_a_failed_target_still_asks_with_any_resource(self) -> None:
        self.reply(
            "target demo_thing_create", code=1, stdout=json.dumps({"refused": {"code": "c", "message": "m"}})
        )
        self.write_fixture()
        target = approval.resolve_target(self.runtime, "demo_thing_create", {})
        self.assertIsNone(target.refused)
        self.assertEqual(target.resources, [approval.ANY_RESOURCE])
        self.assertEqual(self.decide()["action"], "approve")

    def test_a_read_is_left_alone(self) -> None:
        self.answer({"code": "c", "message": "m"})
        self.assertIsNone(self.decide(tool_name="demo_thing_read"))


class DisplayLanguageTest(unittest.TestCase):
    def hermes_says(self, get_language: Any) -> Any:
        """Put an ``agent.i18n`` whose ``get_language`` is ``get_language`` where ``import`` finds it."""
        i18n = types.ModuleType("agent.i18n")
        i18n.get_language = get_language
        agent = types.ModuleType("agent")
        agent.i18n = i18n
        return mock.patch.dict(sys.modules, {"agent": agent, "agent.i18n": i18n})

    def test_it_is_the_display_language_of_hermes(self) -> None:
        with self.hermes_says(lambda: "ja"):
            self.assertEqual(approval.display_language(), "ja")
        with self.hermes_says(lambda: " zh-Hans "):
            self.assertEqual(approval.display_language(), "zh-Hans")

    def test_it_knows_nothing_without_hermes_or_when_hermes_fails_or_answers_junk(self) -> None:
        def failing() -> str:
            raise RuntimeError("boom")

        with mock.patch.dict(sys.modules, {"agent": None, "agent.i18n": None}):
            self.assertIsNone(approval.display_language())
        for get_language in (failing, lambda: None, lambda: "", lambda: "  ", lambda: 3):
            with self.subTest(get_language=get_language), self.hermes_says(get_language):
                self.assertIsNone(approval.display_language())

    def test_it_imports_nothing_when_the_module_loads(self) -> None:
        source = Path(approval.__file__).read_text(encoding="utf-8")
        self.assertNotRegex(source, r"(?m)^(from|import) agent\b")


if __name__ == "__main__":
    unittest.main()
