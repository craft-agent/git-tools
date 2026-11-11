"""Tests of finding node, running the command line, and stopping it on a timeout."""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from support import FAKE_CLI, ROOT, FakeCliCase, runtime, tools


class RuntimeTest(unittest.TestCase):
    def test_node_comes_from_hermes_first(self) -> None:
        hermes_constants = types.SimpleNamespace(find_node_executable=lambda command: f"/pm/{command}")
        with mock.patch.dict(sys.modules, {"hermes_constants": hermes_constants}), mock.patch.object(
            shutil, "which", return_value="/usr/bin/node"
        ):
            self.assertEqual(runtime._find_node(), "/pm/node")

    def test_node_falls_back_to_path_when_hermes_has_none_or_fails(self) -> None:
        def broken(command: str) -> str:
            raise RuntimeError("pm is not set up")

        for lookup in (lambda command: None, broken):
            hermes_constants = types.SimpleNamespace(find_node_executable=lookup)
            with mock.patch.dict(sys.modules, {"hermes_constants": hermes_constants}), mock.patch.object(
                shutil, "which", return_value="/usr/bin/node"
            ):
                self.assertEqual(runtime._find_node(), "/usr/bin/node")

    def test_node_falls_back_to_path_without_hermes(self) -> None:
        with mock.patch.dict(sys.modules, {"hermes_constants": None}), mock.patch.object(
            shutil, "which", return_value="/usr/bin/node"
        ):
            self.assertEqual(runtime._find_node(), "/usr/bin/node")

    def test_locating_names_what_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as root, mock.patch.object(runtime, "PLUGIN_DIR", Path(root)):
            with mock.patch.object(runtime, "_find_node", return_value=None), self.assertRaisesRegex(
                runtime.Unavailable, "node"
            ):
                runtime.locate_runtime()
            with mock.patch.object(runtime, "_find_node", return_value="/usr/bin/node"), self.assertRaisesRegex(
                runtime.Unavailable, "cli.js"
            ):
                runtime.locate_runtime()
            (Path(root) / "dist").mkdir()
            (Path(root) / "dist" / "cli.js").write_text("", encoding="utf-8")
            with mock.patch.object(runtime, "_find_node", return_value="/usr/bin/node"):
                self.assertEqual(
                    runtime.locate_runtime(),
                    runtime.Runtime("/usr/bin/node", Path(root) / "dist" / "cli.js", Path(root) / "skills"),
                )

    def test_the_plugin_dir_is_the_repository_root(self) -> None:
        self.assertEqual(runtime.PLUGIN_DIR, ROOT)
        self.assertTrue((runtime.PLUGIN_DIR / "plugin.yaml").is_file())

    def test_the_cwd_is_hermes_agent_cwd(self) -> None:
        stub = types.SimpleNamespace(resolve_agent_cwd=lambda: Path("/workspace/project"))
        modules = {"agent": types.ModuleType("agent"), "agent.runtime_cwd": stub}
        with mock.patch.dict(sys.modules, modules):
            self.assertEqual(runtime.agent_cwd(), "/workspace/project")

    def test_the_cwd_falls_back_to_the_process_cwd_without_hermes(self) -> None:
        with mock.patch.dict(sys.modules, {"agent": None}), mock.patch("os.getcwd", return_value="/launch"):
            self.assertEqual(runtime.agent_cwd(), "/launch")


class ProcessGroupTest(FakeCliCase):
    """A call that times out leaves neither the command line nor what it started running."""

    def alive(self, pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return True

    def pids(self) -> dict[str, int]:
        return {name: int((self.dir / name).read_text(encoding="utf-8")) for name in ("fake", "child")}

    def assert_all_stopped(self, pids: dict[str, int]) -> None:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and any(self.alive(pid) for pid in pids.values()):
            time.sleep(0.05)
        self.assertEqual({name: self.alive(pid) for name, pid in pids.items()}, {"fake": False, "child": False})

    def kill_leftovers(self) -> None:
        """Whatever a failing test left running must not outlive it."""
        if not (self.dir / "child").exists():
            return
        for pid in self.pids().values():
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass

    def run_until_timeout(self, **reply: Any) -> dict[str, Any]:
        self.addCleanup(self.kill_leftovers)
        self.reply("run demo_thing_create", sleep=30, pid_dir=str(self.dir), **reply)
        handler = self.register().tools["demo_thing_create"]["handler"]
        started = time.monotonic()
        with mock.patch.object(tools, "RUN_TIMEOUT_SECONDS", 0.5), mock.patch.object(
            runtime, "TERMINATE_GRACE_SECONDS", 0.5
        ):
            result = json.loads(handler({}))
        self.assertLess(time.monotonic() - started, 10)
        return result

    @unittest.skipUnless(os.name == "posix", "process groups are POSIX")
    def test_a_timeout_stops_the_command_line_and_its_child(self) -> None:
        result = self.run_until_timeout()
        self.assertIn("did not finish", result["error"])
        self.assert_all_stopped(self.pids())

    @unittest.skipUnless(os.name == "posix", "process groups are POSIX")
    def test_a_command_line_that_ignores_sigterm_is_killed_after_the_grace(self) -> None:
        result = self.run_until_timeout(ignore_sigterm=True)
        self.assertIn("did not finish", result["error"])
        self.assert_all_stopped(self.pids())


class NodeGoneTest(FakeCliCase):
    """A call whose recorded node was removed while Hermes ran looks for node again before it fails."""

    def gone_runtime(self, *found: Any) -> tuple[Any, mock.Mock]:
        lookup = mock.Mock(side_effect=list(found))
        gone = runtime.Runtime(node=str(self.dir / "gone" / "node"), cli=FAKE_CLI, skills_dir=self.skills_dir)
        gone.find_node = lookup
        self.write_fixture()
        return gone, lookup

    def test_a_gone_node_is_found_again_and_kept(self) -> None:
        gone, lookup = self.gone_runtime(sys.executable)
        self.assertEqual(gone.run(["list"], timeout=10).code, 0)
        self.assertEqual(gone.node, sys.executable)
        self.assertEqual(gone.run(["list"], timeout=10).code, 0)
        self.assertEqual(lookup.call_count, 1)
        self.assertEqual([call["argv"] for call in self.calls()], [["list"], ["list"]])

    def test_without_another_node_the_error_names_the_gone_node_and_the_fix(self) -> None:
        for found in (None, "", RuntimeError("pm is not set up")):
            with self.subTest(found=found):
                gone, lookup = self.gone_runtime(found)
                before = gone.node
                with self.assertRaises(runtime.CliError) as raised:
                    gone.run(["list"], timeout=10)
                self.assertIn(f"node is gone from {before}", str(raised.exception))
                self.assertIn("install Node.js 24 or later, then restart Hermes", str(raised.exception))
                self.assertEqual(gone.node, before)
                self.assertEqual(lookup.call_count, 1)

    def test_a_lookup_that_finds_the_same_gone_node_finds_none(self) -> None:
        gone, _ = self.gone_runtime(str(self.dir / "gone" / "node"))
        with self.assertRaisesRegex(runtime.CliError, "node is gone from"):
            gone.run(["list"], timeout=10)

    def test_a_node_that_is_there_but_cannot_start_is_not_looked_for_again(self) -> None:
        unrunnable = self.dir / "node"
        unrunnable.write_text("", encoding="utf-8")
        unrunnable.chmod(0o644)
        lookup = mock.Mock(return_value=sys.executable)
        broken = runtime.Runtime(node=str(unrunnable), cli=FAKE_CLI, skills_dir=self.skills_dir, find_node=lookup)
        with self.assertRaisesRegex(runtime.CliError, "could not be started: .*Errno"):
            broken.run(["list"], timeout=10)
        lookup.assert_not_called()
        self.assertEqual(broken.node, str(unrunnable))

    def test_a_node_another_call_found_again_is_taken_without_looking(self) -> None:
        gone, lookup = self.gone_runtime()
        old = gone.node
        gone.node = sys.executable
        self.assertEqual(gone._find_again(old), sys.executable)
        lookup.assert_not_called()

    def test_the_default_lookup_is_the_plugins(self) -> None:
        gone = runtime.Runtime(node=str(self.dir / "gone" / "node"), cli=FAKE_CLI, skills_dir=self.skills_dir)
        self.write_fixture()
        with mock.patch.object(runtime, "_find_node", return_value=sys.executable) as lookup:
            self.assertEqual(gone.run(["list"], timeout=10).code, 0)
        lookup.assert_called_once_with()
        self.assertEqual(gone.node, sys.executable)


if __name__ == "__main__":
    unittest.main()
