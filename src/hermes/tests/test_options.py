"""Tool options reach listing, execution and approval with the same values."""

from __future__ import annotations

import json
from unittest import mock

from support import CWD, FakeCliCase, project


class ToolOptionsTest(FakeCliCase):
    def test_options_reach_list_run_and_target(self) -> None:
        self.reply("run demo_thing_create", stdout='{"result":{}}')
        self.reply("target demo_thing_create", stdout='{"resources":["north"]}')
        with mock.patch.object(project, "OPTIONS", {"note_text": "text", "note_count": "number"}):
            ctx = self.register({"note_text": " hello ", "note_count": 3, "toolsets": ["things"], "language": "ja"})
        ctx.tools["demo_thing_create"]["handler"]({"target": "north"})
        ctx.hooks[0][1](tool_name="demo_thing_create", args={"target": "north"})
        calls = self.calls()
        options = ["--note-text", "hello", "--note-count", "3"]
        self.assertEqual(calls[0]["argv"], ["list", "--toolsets", "things", *options])
        self.assertEqual(
            calls[1]["argv"], ["run", "demo_thing_create", "--cwd", CWD, "--toolsets", "things", *options]
        )
        self.assertEqual(
            calls[2]["argv"], ["target", "demo_thing_create", "--cwd", CWD, "--language=ja", *options]
        )
        self.assertEqual(json.loads(calls[1]["stdin"]), {"target": "north"})

    def test_wrong_option_types_register_nothing(self) -> None:
        with mock.patch.object(project, "OPTIONS", {"note_count": "number"}):
            ctx = self.register({"note_count": True})
        self.assertEqual(ctx.tools, {})
        self.assertEqual(ctx.hooks, [])
        self.assertEqual(self.calls(), [])
