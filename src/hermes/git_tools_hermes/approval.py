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
ANY_RESOURCE = card.ANY_RESOURCE

#: The Hermes hook that can hold a tool call for the person's approval.
HOOK_NAME = "pre_tool_call"


@dataclass(frozen=True)
class Target:
    """What one ``target`` run says of a call: its resources, description, translated title and intent, and the card's words.

    A ``title`` or ``intent`` of ``None`` is the tool's registered one, or none, and the ``words`` default to English.
    """

    resources: list[str]
    description: card.Description | None
    title: str | None = None
    words: card.Words = card.ENGLISH_WORDS
    intent: str | None = None


def _non_blank(value: Any) -> str | None:
    """``value`` stripped when it is a string with something in it, else ``None``."""
    return (value.strip() or None) if isinstance(value, str) else None


def display_language() -> str | None:
    """Hermes' display language (``agent.i18n.get_language()``), or ``None`` when it cannot be told.

    ``agent.i18n`` is imported here and not at module level: the plugin loads where Hermes' package is absent.
    """
    try:
        from agent.i18n import get_language

        return _non_blank(get_language())
    except Exception:
        return None


def _known(read: Callable[[], str | None]) -> str | None:
    """What ``read`` gives when it gives a non-blank string; a reader that raises or gives anything else knows nothing."""
    try:
        return _non_blank(read())
    except Exception:
        return None


def language_flags(language: str | None, harness_language: str | None) -> list[str]:
    """The flags that tell ``target`` the language set for the plugin and the harness's, each when known.

    Each value is joined to its flag with ``=``, so a value that starts with ``--`` is read as a value, not a flag.
    """
    flags: list[str] = []
    if language:
        flags.append(f"--language={language}")
    if harness_language:
        flags.append(f"--harness-language={harness_language}")
    return flags


def resolve_target(
    runtime: Runtime,
    tool_id: str,
    args: Any,
    language: str | None = None,
    harness_language: Callable[[], str | None] = lambda: display_language(),
) -> Target:
    """What ``target`` prints: ``["*"]`` for resources that cannot be told, no description for one absent or bad.

    ``language`` is the plugin's ``language`` setting and ``harness_language`` reads Hermes' display language
    per call; neither may fail the run, and ``target`` picks among them.
    """
    try:
        result = runtime.run(
            ["target", tool_id, "--cwd", agent_cwd(), *language_flags(language, _known(harness_language))],
            stdin=json.dumps(args if isinstance(args, dict) else {}),
            timeout=TARGET_TIMEOUT_SECONDS,
        )
        document = json.loads(result.stdout) if result.code == 0 else None
        if not isinstance(document, dict):
            return Target([ANY_RESOURCE], None)
        resources = document.get("resources")
        description = card.parse_description(document.get("description"))
        title = card.parse_line(document.get("title"))
        intent = card.parse_line(document.get("intent"))
        words = card.parse_words(document.get("words"))
        if isinstance(resources, list) and resources and all(isinstance(item, str) and item for item in resources):
            return Target(resources, description, title, words, intent)
        return Target([ANY_RESOURCE], description, title, words, intent)
    except Exception:  # an approval is asked for either way; only its resources are lost
        return Target([ANY_RESOURCE], None)


def rule_key(tool_id: str, resources: list[str]) -> str:
    """The key an "always" answer is stored under: the resources as a JSON list, so no two lists share one."""
    return f"{project.PLUGIN_NAME}:{tool_id}:{json.dumps(resources, separators=(',', ':'))}"


def _message(tool: ToolInfo, target: Target, surface: Callable[[], str | None]) -> str:
    """The card's message: the stand-in line, its targets and its description, fitted to the session's surface.

    The stand-in line, which shows where no headline stands, is the first of
    the intent ``target`` translated, its translated title, the tool's listed
    intent and its registered title. A hook that raises asks nothing, so a
    card that cannot be built falls back to the one without a description,
    with the same line and words, and that one to the line alone.
    """
    stand_in = target.intent or target.title or tool.intent or tool.title
    try:
        return card.build_message(stand_in, target.resources, target.description, surface(), target.words)
    except Exception:
        pass
    try:
        return card.build_message(stand_in, target.resources, None, None, target.words)
    except Exception:
        return stand_in


def make_hook(
    runtime: Runtime,
    tools: list[ToolInfo],
    surface: Callable[[], str | None] = lambda: None,
    language: str | None = None,
    harness_language: Callable[[], str | None] = lambda: display_language(),
) -> Callable[..., dict[str, str] | None]:
    """The ``pre_tool_call`` hook: it sends every call of these tools but a read to the person's approval.

    Whether a person is there to ask, and what happens when none is, is
    Hermes' own gate to decide. ``language`` is the plugin's ``language``
    setting; ``harness_language`` is read on every call.
    """
    by_id = {tool.id: tool for tool in tools}

    def hook(tool_name: str = "", args: Any = None, **kwargs: Any) -> dict[str, str] | None:
        tool = by_id.get(tool_name)
        if tool is None or tool.write_class == READ_CLASS:
            return None
        target = resolve_target(runtime, tool.id, args, language, harness_language)
        resources = target.resources
        key = rule_key(tool.id, resources)
        if ANY_RESOURCE in resources:
            # Hermes falls back to the bare tool name for a missing rule_key, which an "always" would turn into a
            # grant for every resource; a key no later call repeats leaves nothing reusable.
            key = f"{key}:once-{uuid.uuid4().hex}"
        return {"action": "approve", "message": _message(tool, target, surface), "rule_key": key}

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


def register_approval(
    ctx: PluginContext, runtime: Runtime, tools: list[ToolInfo], language: str | None = None
) -> None:
    """Hold every non-read call of ``tools`` for approval, with the card in ``language`` (the plugin's setting)."""
    ctx.register_hook(
        HOOK_NAME, make_hook(runtime, tools, surface=lambda: session_surface(ctx), language=language)
    )
