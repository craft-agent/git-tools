"""Asking the person before a tool that changes something runs."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .context import PluginContext
from .listing import READ_CLASS, ToolInfo
from . import card, project
from .runtime import Runtime, agent_cwd

#: How long ``target`` may take, in seconds. Hermes stops a ``pre_tool_call`` hook after 30 s and blocks the call.
TARGET_TIMEOUT_SECONDS = 20

#: What an approval rule matches when a resource a call writes to cannot be told.
ANY_RESOURCE = "*"

#: The Hermes hook that can hold a tool call for the person's approval.
HOOK_NAME = "pre_tool_call"


@dataclass(frozen=True)
class Target:
    """The resources a call writes to and its description, from the same ``target`` run."""

    resources: list[str]
    description: card.Description | None


def resolve_target(runtime: Runtime, tool_id: str, args: Any) -> Target:
    """What ``target`` prints: ``["*"]`` for resources that cannot be told, no description for one absent or bad."""
    try:
        result = runtime.run(
            ["target", tool_id, "--cwd", agent_cwd()],
            stdin=json.dumps(args if isinstance(args, dict) else {}),
            timeout=TARGET_TIMEOUT_SECONDS,
        )
        document = json.loads(result.stdout) if result.code == 0 else None
        if not isinstance(document, dict):
            return Target([ANY_RESOURCE], None)
        resources = document.get("resources")
        description = card.parse_description(document.get("description"))
        if isinstance(resources, list) and resources and all(isinstance(item, str) and item for item in resources):
            return Target(resources, description)
        return Target([ANY_RESOURCE], description)
    except Exception:  # an approval is asked for either way; only its resources are lost
        return Target([ANY_RESOURCE], None)


def rule_key(tool_id: str, resources: list[str]) -> str:
    """The key an "always" answer is stored under: the resources as a JSON list, so no two lists share one."""
    return f"{project.PLUGIN_NAME}:{tool_id}:{json.dumps(resources, separators=(',', ':'))}"


def make_hook(
    runtime: Runtime, tools: list[ToolInfo], surface: Callable[[], str | None] = lambda: None
) -> Callable[..., dict[str, str] | None]:
    """The ``pre_tool_call`` hook: it sends every call of these tools but a read to the person's approval.

    Whether a person is there to ask, and what happens when none is, is
    Hermes' own gate to decide.
    """
    by_id = {tool.id: tool for tool in tools}

    def hook(tool_name: str = "", args: Any = None, **kwargs: Any) -> dict[str, str] | None:
        tool = by_id.get(tool_name)
        if tool is None or tool.write_class == READ_CLASS:
            return None
        target = resolve_target(runtime, tool.id, args)
        resources = target.resources
        subject = tool.title if resources == [ANY_RESOURCE] else f"{tool.title} on {', '.join(resources)}"
        key = rule_key(tool.id, resources)
        if ANY_RESOURCE in resources:
            # Hermes falls back to the bare tool name for a missing rule_key, which an "always" would turn into a
            # grant for every resource; a key no later call repeats leaves nothing reusable.
            key = f"{key}:once-{uuid.uuid4().hex}"
        header = f"{subject} ({tool.id})"
        try:
            message = card.build_message(header, target.description, surface() if target.description else None)
        except Exception:  # a hook that raises asks nothing, so the card falls back to the line without a description
            message = header
        return {"action": "approve", "message": message, "rule_key": key}

    return hook


def session_surface(ctx: PluginContext) -> str | None:
    """Hermes' ``PluginContext.session_surface()`` names where the session runs (cli, tui, telegram, …).

    Older Hermes has none, and then the card gets the strictest surface.
    """
    value = getattr(ctx, "session_surface", None)
    if callable(value):
        try:
            value = value()
        except Exception:
            return None
    return value if isinstance(value, str) and value else None


def register_approval(ctx: PluginContext, runtime: Runtime, tools: list[ToolInfo]) -> None:
    """Hold every non-read call of ``tools`` for approval."""
    ctx.register_hook(HOOK_NAME, make_hook(runtime, tools, surface=lambda: session_surface(ctx)))
