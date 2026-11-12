"""Asking the person before a tool that changes something runs."""

from __future__ import annotations

import json
import re
import threading
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

#: The argument the pin hook sets on a call for the handler to read: it carries the pin of what the approval showed.
#: No tool argument starts with ``_``, so it never collides with one, and the handler removes it before the call runs.
PIN_ARGUMENT = f"_{project.PLUGIN_NAME}_pin"

#: What a pin looks like: 64 lowercase hexadecimal characters.
PIN_PATTERN = re.compile(r"[0-9a-f]{64}")

#: How many pins the stash keeps; the oldest goes when a new one comes in beyond this.
PIN_STASH_LIMIT = 256


@dataclass(frozen=True)
class Target:
    """What one ``target`` run says of a call: its resources, description, translated title and intent, and the card's words.

    A ``title`` or ``intent`` of ``None`` is the tool's registered one, or none, and the ``words`` default to English.
    A ``pin`` of ``None`` is none given (or a malformed one); it comes only with a description.
    """

    resources: list[str]
    description: card.Description | None
    title: str | None = None
    words: card.Words = card.ENGLISH_WORDS
    intent: str | None = None
    pin: str | None = None


def parse_pin(value: Any) -> str | None:
    """``value`` when it is a pin (64 lowercase hex characters), else ``None``."""
    return value if isinstance(value, str) and PIN_PATTERN.fullmatch(value) else None


def run_arguments(args: Any) -> dict[str, Any]:
    """The arguments a call runs with: ``args`` without ``PIN_ARGUMENT``, or none when ``args`` is not a dict.

    The approval describes these and the handler runs these, so a pin argument the model sent
    itself can neither blank the card nor reach the tool.
    """
    return {key: value for key, value in args.items() if key != PIN_ARGUMENT} if isinstance(args, dict) else {}


#: Where a pin waits: the call's ``task_id``, ``session_id`` and ``tool_call_id``, a missing id read as ``""``.
PinKey = tuple[str, str, str]


class PinStash:
    """The pins of calls waiting between the approval hook and the pin hook, by ``PinKey``.

    One plugin serves every session and task, and providers may number calls per response, so a ``tool_call_id``
    alone can repeat across sessions and across the tasks of a run that has no session.

    Thread-safe and bounded: when full, the oldest pin is dropped.
    """

    def __init__(self, limit: int = PIN_STASH_LIMIT) -> None:
        self._limit = limit
        self._lock = threading.Lock()
        self._pins: dict[PinKey, str] = {}

    def put(self, key: PinKey, pin: str) -> None:
        """Keep ``pin`` under ``key``, dropping the oldest entries beyond the limit."""
        with self._lock:
            self._pins.pop(key, None)
            self._pins[key] = pin
            while len(self._pins) > self._limit:
                del self._pins[next(iter(self._pins))]

    def take(self, key: PinKey) -> str | None:
        """The pin kept under ``key``, removed; ``None`` when there is none."""
        with self._lock:
            return self._pins.pop(key, None)


def _non_blank(value: Any) -> str | None:
    """``value`` stripped when it is a string with something in it, else ``None``."""
    return (value.strip() or None) if isinstance(value, str) else None


def pin_key(hook_kwargs: dict[str, Any]) -> PinKey | None:
    """The ``PinKey`` of the call a hook was given, or ``None`` without a usable ``tool_call_id``.

    Hermes hands both hooks of one call the same ids. A blank or missing ``task_id`` or ``session_id`` reads as
    ``""``, so a run that carries neither still pins its calls by ``tool_call_id``; two such calls that share a key
    at once can only fail one as ``stale`` or run the other unpinned.
    """
    call_id = _non_blank(hook_kwargs.get("tool_call_id"))
    if call_id is None:
        return None
    task_id = _non_blank(hook_kwargs.get("task_id")) or ""
    session_id = _non_blank(hook_kwargs.get("session_id")) or ""
    return (task_id, session_id, call_id)


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
    option_flags: list[str] | None = None,
) -> Target:
    """What ``target`` prints: ``["*"]`` for resources that cannot be told, no description for one absent or bad.

    ``language`` is the plugin's ``language`` setting and ``harness_language`` reads Hermes' display language
    per call; neither may fail the run, and ``target`` picks among them.
    """
    try:
        result = runtime.run(
            [
                "target", tool_id, "--cwd", agent_cwd(),
                *language_flags(language, _known(harness_language)), *(option_flags or []),
            ],
            stdin=json.dumps(run_arguments(args)),
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
        pin = parse_pin(document.get("pin"))
        if isinstance(resources, list) and resources and all(isinstance(item, str) and item for item in resources):
            return Target(resources, description, title, words, intent, pin)
        return Target([ANY_RESOURCE], description, title, words, intent, pin)
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
    pins: PinStash | None = None,
    option_flags: list[str] | None = None,
) -> Callable[..., dict[str, str] | None]:
    """The ``pre_tool_call`` hook: it sends every call of these tools but a read to the person's approval.

    Whether a person is there to ask, and what happens when none is, is
    Hermes' own gate to decide. ``language`` is the plugin's ``language``
    setting; ``harness_language`` is read on every call. When ``pins`` is
    given, the pin ``target`` answered is kept in it under the call's
    ``pin_key`` for the pin hook; the decision is the same either way.
    """
    by_id = {tool.id: tool for tool in tools}

    def hook(tool_name: str = "", args: Any = None, **kwargs: Any) -> dict[str, str] | None:
        tool = by_id.get(tool_name)
        if tool is None or tool.write_class == READ_CLASS:
            return None
        target = resolve_target(runtime, tool.id, args, language, harness_language, option_flags)
        call = pin_key(kwargs)
        if pins is not None and call is not None:
            # An entry left by a call that never reached the pin hook must not stand for this one.
            if target.pin:
                pins.put(call, target.pin)
            else:
                pins.take(call)
        resources = target.resources
        key = rule_key(tool.id, resources)
        if ANY_RESOURCE in resources:
            # Hermes falls back to the bare tool name for a missing rule_key, which an "always" would turn into a
            # grant for every resource; a key no later call repeats leaves nothing reusable.
            key = f"{key}:once-{uuid.uuid4().hex}"
        return {"action": "approve", "message": _message(tool, target, surface), "rule_key": key}

    return hook


def make_pin_hook(tools: list[ToolInfo], pins: PinStash) -> Callable[..., dict[str, Any] | None]:
    """The second ``pre_tool_call`` hook: it hands each non-read call the pin its approval showed.

    The result modifies the call's args so that ``PIN_ARGUMENT`` is always set, to the pin
    kept by the approval hook or to ``""`` when there is none, so a value the model sent
    itself never stands. Any other tool, and a read, is left alone. It never raises.
    """
    by_id = {tool.id: tool for tool in tools}

    def hook(tool_name: str = "", args: Any = None, **kwargs: Any) -> dict[str, Any] | None:
        tool = by_id.get(tool_name)
        if tool is None or tool.write_class == READ_CLASS:
            return None
        pin = ""
        try:
            call = pin_key(kwargs)
            pin = (pins.take(call) if call is not None else None) or ""
        except Exception:
            pass
        return {"action": "modify", "args": {PIN_ARGUMENT: pin}}

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
    ctx: PluginContext,
    runtime: Runtime,
    tools: list[ToolInfo],
    language: str | None = None,
    option_flags: list[str] | None = None,
) -> None:
    """Hold every non-read call of ``tools`` for approval, with the card in ``language`` (the plugin's setting).

    Two hooks, in this order, since Hermes runs them in registration order: the approval hook
    stashes the pin of what the card shows, then the pin hook gives it to the call.
    """
    pins = PinStash()
    ctx.register_hook(
        HOOK_NAME,
        make_hook(
            runtime, tools, surface=lambda: session_surface(ctx), language=language, pins=pins, option_flags=option_flags
        ),
    )
    ctx.register_hook(HOOK_NAME, make_pin_hook(tools, pins))
