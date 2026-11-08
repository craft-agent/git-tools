"""The message of the approval card: the header and what the call carries, fitted to the surface it is shown on."""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Any

#: The categories whose code points are shown as a mark: control, format, line and
#: paragraph separators, lone surrogates.
HIDDEN_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp", "Cs"})

#: The default-ignorable code points, including variation selectors and the Hangul fillers.
DEFAULT_IGNORABLE = (
    (0x00AD, 0x00AD),
    (0x034F, 0x034F),
    (0x061C, 0x061C),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x206F),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFF8),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
)


def _mark(character: str) -> str:
    return f"<U+{ord(character):04X}>"


def visible(text: str, keep_newlines: bool = False) -> str:
    """Show every code point another person could use to forge a line or hide part of a value as ``<U+XXXX>``.

    These are control, format, separators, lone surrogates and the default-ignorable
    code points (such as variation selectors and the Hangul fillers); ordinary spaces and all
    visible text stay. With ``keep_newlines``, ``\\r\\n`` becomes ``\\n`` and
    ``\\n`` stays; any other ``\\r`` is marked. The same rules as ``visible`` in
    ``src/entry/description.ts``.
    """
    if keep_newlines:
        text = text.replace("\r\n", "\n")
    return "".join(
        _mark(character)
        if (
            unicodedata.category(character) in HIDDEN_CATEGORIES
            or any(first <= ord(character) <= last for first, last in DEFAULT_IGNORABLE)
        )
        and not (keep_newlines and character == "\n")
        else character
        for character in text
    )


@dataclass(frozen=True)
class Description:
    """What a call carries: short ``(label, value)`` facts and an optional free text, as ``describe`` gave them."""

    facts: tuple[tuple[str, str], ...]
    text: str | None


def _parse_fact(raw: Any) -> tuple[str, str] | None:
    if not isinstance(raw, dict):
        return None
    label, value = raw.get("label"), raw.get("value")
    if not isinstance(label, str) or not label.strip() or not isinstance(value, str):
        return None
    return label, value


def parse_description(raw: Any) -> Description | None:
    """The description the command line printed, or ``None`` for any other shape or for one that says nothing.

    ``{"facts": [{"label": str, "value": str}, ...], "text"?: str}``; extra keys
    are ignored. Nothing is marked here: ``build_message`` does.
    """
    if not isinstance(raw, dict) or not isinstance(raw.get("facts"), list):
        return None
    parsed = [_parse_fact(item) for item in raw["facts"]]
    facts = tuple(fact for fact in parsed if fact is not None)
    text = raw.get("text", "")
    if len(facts) != len(parsed) or not isinstance(text, str) or not (facts or text):
        return None
    return Description(facts=facts, text=text or None)
