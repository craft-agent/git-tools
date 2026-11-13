"""Refusing writes while a plugin the package requires is not loaded."""

from __future__ import annotations

from typing import Any

from .approval import GUARD_FAILED_TEXT, Guard, error_text

#: The refusal reason when a required plugin is not loaded or cannot be checked.
MISSING_PLUGIN_REASON = "missing_plugin"


def missing_plugins(ctx: Any, names: list[str]) -> list[str]:
    """The names not known to be loaded, in order; an unavailable check counts as missing."""
    missing: list[str] = []
    for name in names:
        try:
            has_plugin = getattr(ctx, "has_plugin", None)
            if callable(has_plugin) and has_plugin(name) is True:
                continue
        except Exception:
            pass
        missing.append(name)
    return missing


def refusal_text(missing: list[str]) -> str:
    """The forbidden error text and its details naming the missing plugins."""
    message = f"A plugin this package requires is not loaded: {', '.join(missing)}; writes are refused until it loads."
    text = error_text({
        "code": "forbidden",
        "message": message,
        "details": {"reason": MISSING_PLUGIN_REASON, "plugins": missing},
    })
    # ``error_text`` is ``None`` only for a malformed error object, which this one is not; refuse all the same.
    return GUARD_FAILED_TEXT if text is None else text


def make_guard(ctx: Any, names: list[str]) -> Guard | None:
    """A per-call required-plugin check that never raises, or none when no plugins are required."""
    if not names:
        return None

    def guard() -> str | None:
        try:
            missing = missing_plugins(ctx, names)
            return refusal_text(missing) if missing else None
        except Exception:
            return refusal_text(list(names))

    return guard
