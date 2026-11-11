"""Where the plugin finds node, the command line it calls, and how it runs it."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import threading
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path

from . import project

#: Whether processes have groups the plugin can signal as a whole.
_POSIX = os.name == "posix"

#: How long a command line that was sent ``SIGTERM`` may keep running before it is sent ``SIGKILL``, in seconds.
TERMINATE_GRACE_SECONDS = 2

#: The repository root, where ``plugin.yaml`` sits: this file is
#: ``<root>/src/hermes/git_tools_hermes/runtime.py``.
PLUGIN_DIR = Path(__file__).resolve().parents[3]

#: The built command line, relative to ``PLUGIN_DIR``.
CLI_PATH = Path("dist") / "cli.js"

#: The folder holding ``<skill>/SKILL.md`` files, relative to ``PLUGIN_DIR``.
SKILLS_PATH = Path("skills")


class Unavailable(Exception):
    """The plugin cannot offer its tools; the message says why, for one log line."""


class CliError(Exception):
    """The command line could not run to its end (it timed out or could not start)."""


@dataclass(frozen=True)
class CliResult:
    """What a finished command line left behind."""

    code: int
    stdout: str
    stderr: str


@dataclass
class Runtime:
    """What the plugin needs from its install: node, the built command line and the skills folder.

    ``node`` is the path found when the plugin was registered. A version manager names one
    version in it and may remove that version while Hermes runs, so a call that finds it gone
    looks for node again with ``find_node`` and keeps what it finds.
    """

    node: str
    cli: Path
    skills_dir: Path
    find_node: Callable[[], str | None] = field(default=lambda: _find_node(), compare=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, compare=False, repr=False)

    def run(self, args: list[str], *, stdin: str = "", timeout: float) -> CliResult:
        """Run ``node <cli> <args>`` with ``stdin`` as its input, without a shell.

        On POSIX the command line leads a process group of its own, which a timeout stops
        as a whole. When the recorded node is gone, it is looked for again once before the
        call fails.

        Raises:
            CliError: the command line timed out or could not be started, or node is gone.
        """
        node = self.node
        try:
            process = self._start(node, args)
        except OSError as error:
            if os.path.exists(node):
                raise CliError(f"{project.CLI_NAME} could not be started: {error}") from error
            found = self._find_again(node)
            if found is None:
                raise CliError(
                    f"{project.CLI_NAME} could not be started: node is gone from {node}; install Node.js 24 or later, "
                    "then restart Hermes from a shell where `node` runs"
                ) from error
            try:
                process = self._start(found, args)
            except OSError as again:
                raise CliError(f"{project.CLI_NAME} could not be started: {again}") from again
        try:
            stdout, stderr = process.communicate(input=stdin, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            _stop(process)
            raise CliError(f"{project.CLI_NAME} did not finish within {timeout:g} seconds") from error
        except BaseException:
            _stop(process)
            raise
        return CliResult(process.returncode, stdout, stderr)

    def _start(self, node: str, args: list[str]) -> subprocess.Popen[str]:
        """Start ``node <cli> <args>`` with its pipes open, leading a process group of its own on POSIX."""
        return subprocess.Popen(
            [node, str(self.cli), *args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=dict(os.environ),
            start_new_session=_POSIX,
        )

    def _find_again(self, gone: str) -> str | None:
        """Node found again in place of ``gone``, kept as ``node``; ``None`` when there is no other.

        Calls that find the same node gone at once look for it once: a later one takes what the first kept.
        """
        with self._lock:
            if self.node != gone:
                return self.node
            try:
                found = self.find_node()
            except Exception:  # a lookup that fails finds nothing
                found = None
            if not found or found == gone:
                return None
            self.node = found
            return found


def _signal_group(process: subprocess.Popen[str], signal_number: int) -> None:
    """Send a signal to the child and everything it started, which share the child's process group."""
    try:
        os.killpg(process.pid, signal_number)
    except ProcessLookupError:
        pass


def _stop(process: subprocess.Popen[str]) -> None:
    """Stop the child and, on POSIX, the whole process group it leads, then collect what it left.

    The group gets ``SIGTERM`` and ``TERMINATE_GRACE_SECONDS`` to end, then ``SIGKILL``, so a
    child process the command line started does not outlive the call.
    """
    try:
        if _POSIX:
            _signal_group(process, signal.SIGTERM)
        else:
            process.terminate()
        try:
            process.communicate(timeout=TERMINATE_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            if _POSIX:
                _signal_group(process, signal.SIGKILL)
            else:
                process.kill()
            try:
                process.communicate(timeout=TERMINATE_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                # Something left the group while holding the pipes; do not wait for it, only for the child itself.
                with suppress(subprocess.TimeoutExpired):
                    process.wait(timeout=TERMINATE_GRACE_SECONDS)
    finally:
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()


def _find_node() -> str | None:
    """Hermes' own node when it has installed one, else the one on ``PATH``."""
    try:
        from hermes_constants import find_node_executable

        node = find_node_executable("node")
    except Exception:  # any failure of Hermes' lookup falls back to PATH
        node = None
    return node or shutil.which("node")


def locate_runtime() -> Runtime:
    """Find node and the built command line.

    Raises:
        Unavailable: node or ``dist/cli.js`` is missing.
    """
    node = _find_node()
    if node is None:
        raise Unavailable("node was not found; install Node.js 24 or later")
    cli = PLUGIN_DIR / CLI_PATH
    if not cli.is_file():
        raise Unavailable(f"{cli} is missing; run `pnpm run build` in {PLUGIN_DIR}")
    return Runtime(node=node, cli=cli, skills_dir=PLUGIN_DIR / SKILLS_PATH)


def agent_cwd() -> str:
    """The directory the agent works in, which relative paths or contextual targets refer to."""
    try:
        from agent.runtime_cwd import resolve_agent_cwd
    except ImportError:
        return os.getcwd()
    return str(resolve_agent_cwd())
