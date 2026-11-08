"""Tests of the hook that sends calls that write to the person's approval."""

from __future__ import annotations

import json
import re
import sys
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
        broken = runtime.Runtime(node=str(self.dir / "no-node"), cli=FAKE_CLI, skills_dir=self.skills_dir)
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


JAPANESE_WORDS = {"details": "詳細", "target": "対象", "more": "（ほか {count} 件）"}


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
