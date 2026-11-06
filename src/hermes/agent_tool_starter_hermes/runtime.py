"""Where the plugin finds node, the command line it calls, and how it runs it."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

from . import project

#: Whether processes have groups the plugin can signal as a whole.
_POSIX = os.name == "posix"

#: How long a command line that was sent ``SIGTERM`` may keep running before it is sent ``SIGKILL``, in seconds.
TERMINATE_GRACE_SECONDS = 2

#: The repository root, where ``plugin.yaml`` sits: this file is
#: ``<root>/src/hermes/agent_tool_starter_hermes/runtime.py``.
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


@dataclass(frozen=True)
class Runtime:
    """What the plugin needs from its install: node, the built command line and the skills folder."""

    node: str
    cli: Path
    skills_dir: Path

    def run(self, args: list[str], *, stdin: str = "", timeout: float) -> CliResult:
        """Run ``node <cli> <args>`` with ``stdin`` as its input, without a shell.

        On POSIX the command line leads a process group of its own, which a timeout stops
        as a whole.

        Raises:
            CliError: the command line timed out or could not be started.
        """
        try:
            process = subprocess.Popen(
                [self.node, str(self.cli), *args],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=dict(os.environ),
                start_new_session=_POSIX,
            )
        except OSError as error:
            raise CliError(f"{project.CLI_NAME} could not be started: {error}") from error
        try:
            stdout, stderr = process.communicate(input=stdin, timeout=timeout)
        except subprocess.TimeoutExpired as error:
            _stop(process)
            raise CliError(f"{project.CLI_NAME} did not finish within {timeout:g} seconds") from error
        except BaseException:
            _stop(process)
            raise
        return CliResult(process.returncode, stdout, stderr)


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
