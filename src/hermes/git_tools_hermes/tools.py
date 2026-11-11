"""Registering the tools the command line lists, and running one through it."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any

from .approval import PIN_ARGUMENT, parse_pin, run_arguments
from .context import PluginContext
from .listing import ToolInfo
from . import project
from .runtime import CliError, Runtime, agent_cwd

#: How long one call may take, in seconds: a ceiling above what a tool call is expected to take.
RUN_TIMEOUT_SECONDS = 150

#: The toolset name of a tool in ``hermes tools``: the package's toolset after this prefix.
TOOLSET_PREFIX = f"{project.PLUGIN_NAME}-"

#: The emoji each toolset is shown with.
TOOLSET_EMOJI = project.TOOLSET_EMOJI


def error_result(message: str) -> str:
    """The JSON a failed call returns to the model."""
    return json.dumps({"error": message})


def _read_document(stdout: str) -> dict[str, Any] | None:
    """The JSON object a command line wrote, or ``None`` when it wrote something else."""
    try:
        document = json.loads(stdout)
    except json.JSONDecodeError:
        return None
    return document if isinstance(document, dict) else None


def _failure(code: int, stdout: str, stderr: str) -> str:
    """The error result of a command line that did not succeed: its ``<code>: <message>`` and details line, or its stderr."""
    error = (_read_document(stdout) or {}).get("error")
    if isinstance(error, dict) and isinstance(error.get("code"), str) and isinstance(error.get("message"), str):
        message = f"{error['code']}: {error['message']}"
        details = error.get("details")
        if isinstance(details, dict):
            message = f"{message}\n" + json.dumps(details, ensure_ascii=False, separators=(",", ":"))
        return error_result(message)
    detail = stderr.strip() or f"exit status {code}"
    return error_result(f"{project.CLI_NAME} failed: {detail}")


def make_handler(runtime: Runtime, tool_id: str, flags: list[str]) -> Callable[..., str]:
    """The handler Hermes calls for one tool: it takes the arguments as one dict and never raises.

    The pin the pin hook set (``PIN_ARGUMENT``) is taken out of the arguments and, when it is a
    pin, passed to ``run`` as ``--pin``; anything else runs as if there were none.
    """

    def handler(args: dict[str, Any], **kwargs: Any) -> str:
        try:
            pin = parse_pin(args.get(PIN_ARGUMENT))
            result = runtime.run(
                ["run", tool_id, "--cwd", agent_cwd(), *flags, *([f"--pin={pin}"] if pin else [])],
                stdin=json.dumps(run_arguments(args)),
                timeout=RUN_TIMEOUT_SECONDS,
            )
        except CliError as error:
            return error_result(str(error))
        except Exception as error:  # a tool call must reach the model as a result, whatever went wrong
            return error_result(f"{tool_id} could not run: {error}")
        document = _read_document(result.stdout)
        if result.code == 0 and document is not None and "result" in document:
            return result.stdout.strip()
        return _failure(result.code, result.stdout, result.stderr)

    return handler


def register_tools(
    ctx: PluginContext,
    runtime: Runtime,
    tools: list[ToolInfo],
    flags: list[str],
    emoji: Mapping[str, str] | None = None,
) -> None:
    """Register each listed tool under its own ID, grouped in one Hermes toolset per package toolset."""
    toolset_emoji = TOOLSET_EMOJI if emoji is None else emoji
    for tool in tools:
        ctx.register_tool(
            name=tool.id,
            toolset=TOOLSET_PREFIX + tool.toolset.replace("_", "-"),
            schema={"name": tool.id, "description": tool.description, "parameters": tool.input_schema},
            handler=make_handler(runtime, tool.id, flags),
            emoji=toolset_emoji.get(tool.toolset, ""),
            description=tool.title,
        )
