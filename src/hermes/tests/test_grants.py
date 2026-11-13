"""Tests of grant settings and approvals that require a person's own answer."""

from __future__ import annotations

import json
import re
import unittest
from unittest import mock

from support import CWD, FakeCliCase, StubContext, approval, settings, tool_entry


class GrantSettingsTest(unittest.TestCase):
    def test_settings_become_flags_with_the_path_only_trimmed(self) -> None:
        ctx = StubContext({"unattended": True, "grants_dir": " ~/grants \n"})
        expected = ["--unattended", "--grants-dir", "~/grants"]
        self.assertEqual(settings.grant_flags(ctx), expected)
        self.assertEqual(settings.settings_flags(ctx), expected)

    def test_absent_false_and_blank_values_give_no_flags(self) -> None:
        for config in ({}, {"unattended": False, "grants_dir": " \t"}, {"grants_dir": None}):
            with self.subTest(config=config):
                ctx = StubContext(config)
                self.assertEqual(settings.grant_flags(ctx), [])
                self.assertEqual(settings.settings_flags(ctx), [])

    def test_a_non_boolean_unattended_is_refused(self) -> None:
        for value in ("true", 1, 0, [], {}):
            with self.subTest(value=value):
                ctx = StubContext({"unattended": value})
                with self.assertRaises(settings.SettingsError) as error:
                    settings.settings_flags(ctx)
                self.assertEqual(str(error.exception), 'setting "unattended" must be true or false')

    def test_a_non_string_grants_directory_is_refused(self) -> None:
        for value in (True, 3, []):
            with self.subTest(value=value):
                with self.assertRaises(settings.SettingsError) as error:
                    settings.settings_flags(StubContext({"grants_dir": value}))
                self.assertEqual(str(error.exception), 'setting "grants_dir" must be a path')


class GrantCallsTest(FakeCliCase):
    def test_target_and_run_receive_the_same_grant_flags(self) -> None:
        for config, flags in (
            ({"unattended": True, "grants_dir": " ~/grants \n"}, ["--unattended", "--grants-dir", "~/grants"]),
            ({"unattended": False, "grants_dir": " \t"}, []),
        ):
            with self.subTest(config=config):
                self.log.unlink(missing_ok=True)
                self.reply("target demo_thing_create", stdout='{"resources":["target/one"]}')
                self.reply("run demo_thing_create", stdout='{"result":{}}')
                ctx = self.register(config)
                decision = ctx.hooks[0][1](tool_name="demo_thing_create", args={})
                self.assertEqual(decision["action"], "approve")
                ctx.tools["demo_thing_create"]["handler"]({})
                calls = [call for call in self.calls() if call["argv"][0] in ("target", "run")]
                self.assertEqual(
                    [call["argv"] for call in calls],
                    [[command, "demo_thing_create", "--cwd", CWD, *flags] for command in ("target", "run")],
                )

    def test_a_bad_boolean_registers_nothing(self) -> None:
        with self.assertLogs(level="WARNING") as logged:
            ctx = self.register({"unattended": "true"})
        self.assertEqual(ctx.tools, {})
        self.assertEqual(ctx.hooks, [])
        self.assertEqual(self.calls(), [])
        self.assertIn('setting "unattended" must be true or false', logged.output[0])

    def test_an_unattended_refusal_blocks_without_asking(self) -> None:
        self.reply(
            "target demo_thing_create",
            stdout=json.dumps(
                {"refused": {
                    "code": "forbidden",
                    "message": "Create a grant first.",
                    "details": {"reason": "no_grant"},
                }}
            ),
        )
        ctx = self.register({"unattended": True})
        with mock.patch.object(approval, "_message") as message:
            decision = ctx.hooks[0][1](tool_name="demo_thing_create", args={})
        message.assert_not_called()
        self.assertEqual(
            decision,
            {"action": "block", "message": 'forbidden: Create a grant first.\n{"reason":"no_grant"}'},
        )
        [call] = [call for call in self.calls() if call["argv"][0] == "target"]
        self.assertEqual(call["argv"], ["target", "demo_thing_create", "--cwd", CWD, "--unattended"])


class PersonOnlyTest(FakeCliCase):
    def test_each_grant_creation_gets_its_own_single_use_rule_key(self) -> None:
        tool_id = "demo_grant_create"
        self.reply("list", stdout=json.dumps([tool_entry(tool_id, "grants", "administrative")]))
        self.reply(f"target {tool_id}", stdout=json.dumps({"resources": ["target/one"], "person_only": True}))
        hook = self.register().hooks[0][1]
        first = hook(tool_name=tool_id, args={})
        second = hook(tool_name=tool_id, args={})
        prefix = re.escape(approval.rule_key(tool_id, ["target/one"]))
        for decision in (first, second):
            self.assertEqual(decision["action"], "approve")
            self.assertRegex(decision["rule_key"], rf"^{prefix}:once-[0-9a-f]{{32}}$")
        self.assertNotEqual(first["rule_key"], second["rule_key"])
        self.assertEqual(first["message"], second["message"])

    def test_without_person_only_true_named_resources_keep_the_stable_rule(self) -> None:
        for fields in ({}, {"person_only": False}, {"person_only": "true"}, {"person_only": 1}):
            with self.subTest(fields=fields):
                self.reply("target demo_thing_create", stdout=json.dumps({"resources": ["target/one"], **fields}))
                hook = self.register().hooks[0][1]
                for _ in range(2):
                    decision = hook(tool_name="demo_thing_create", args={})
                    self.assertEqual(decision["action"], "approve")
                    self.assertEqual(decision["rule_key"], approval.rule_key("demo_thing_create", ["target/one"]))


if __name__ == "__main__":
    unittest.main()
