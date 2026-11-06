"""Asking the person before a tool that changes something runs."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any

from .context import PluginContext
from .listing import READ_CLASS, ToolInfo
from . import project
from .runtime import Runtime, agent_cwd

#: How long ``target`` may take, in seconds. Hermes stops a ``pre_tool_call`` hook after 30 s and blocks the call.
TARGET_TIMEOUT_SECONDS = 20

#: What an approval rule matches when a resource a call writes to cannot be told.
ANY_RESOURCE = "*"

#: The Hermes hook that can hold a tool call for the person's approval.
HOOK_NAME = "pre_tool_call"


def resolve_resources(runtime: Runtime, tool_id: str, args: Any) -> list[str]:
    """The resources a call writes to, as ``target`` prints them, or ``["*"]`` when they cannot be told."""
    try:
        result = runtime.run(
            ["target", tool_id, "--cwd", agent_cwd()],
            stdin=json.dumps(args if isinstance(args, dict) else {}),
            timeout=TARGET_TIMEOUT_SECONDS,
        )
        resources = json.loads(result.stdout).get("resources") if result.code == 0 else None
    except Exception:  # an approval is asked for either way; only its resources are lost
        return [ANY_RESOURCE]
    if isinstance(resources, list) and resources and all(isinstance(item, str) and item for item in resources):
        return resources
    return [ANY_RESOURCE]


def rule_key(tool_id: str, resources: list[str]) -> str:
    """The key an "always" answer is stored under: the resources as a JSON list, so no two lists share one."""
    return f"{project.PLUGIN_NAME}:{tool_id}:{json.dumps(resources, separators=(',', ':'))}"


def make_hook(runtime: Runtime, tools: list[ToolInfo]) -> Callable[..., dict[str, str] | None]:
    """The ``pre_tool_call`` hook: it sends every call of these tools but a read to the person's approval.

    Whether a person is there to ask, and what happens when none is, is
    Hermes' own gate to decide.
    """
    by_id = {tool.id: tool for tool in tools}

    def hook(tool_name: str = "", args: Any = None, **kwargs: Any) -> dict[str, str] | None:
        tool = by_id.get(tool_name)
        if tool is None or tool.write_class == READ_CLASS:
            return None
        resources = resolve_resources(runtime, tool.id, args)
        subject = tool.title if resources == [ANY_RESOURCE] else f"{tool.title} on {', '.join(resources)}"
        key = rule_key(tool.id, resources)
        if ANY_RESOURCE in resources:
            # Hermes falls back to the bare tool name for a missing rule_key, which an "always" would turn into a
            # grant for every resource; a key no later call repeats leaves nothing reusable.
            key = f"{key}:once-{uuid.uuid4().hex}"
        return {"action": "approve", "message": f"{subject} ({tool.id})", "rule_key": key}

    return hook


def register_approval(ctx: PluginContext, runtime: Runtime, tools: list[ToolInfo]) -> None:
    """Hold every non-read call of ``tools`` for approval."""
    ctx.register_hook(HOOK_NAME, make_hook(runtime, tools))
