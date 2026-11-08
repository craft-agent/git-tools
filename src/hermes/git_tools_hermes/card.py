"""The message of the approval card: the header and what the call carries, fitted to the surface it is shown on."""

from __future__ import annotations

import html
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

#: The budget, in UTF-16 code units of the HTML-escaped text, of the Telegram card;
#: Hermes escapes it and cuts it from the end.
TELEGRAM_BUDGET = 500

#: The budget, in characters, of the Slack card; Hermes cuts it from the end.
SLACK_BUDGET = 500

#: The budget, in characters, of the Discord card, which is also the strictest one; Hermes cuts it from the end.
DISCORD_BUDGET = 300

#: How few code points of a value are worth showing cut; a value that does not keep this many is dropped instead.
MIN_VALUE_CODE_POINTS = 8

#: What stands in the place of the end of a value that was cut.
ELLIPSIS = "…"

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

#: The characters Discord Markdown reads as markup, mentions or links, each escaped by a backslash.
DISCORD_MARKUP = "\\*_~`|><[]()#-@"

#: What Slack's ``mrkdwn`` reads as the start of a mention or link, and so is written as an entity.
SLACK_ENTITIES = {"&": "&amp;", "<": "&lt;", ">": "&gt;"}


@dataclass(frozen=True)
class Surface:
    """Where a card is shown: how much of its message the surface keeps and how the message must be written for it.

    ``budget`` is what ``measure`` may count at most (``None`` for no cut) and ``escape`` makes a text safe in the
    surface's markup; a surface Hermes escapes for itself has the identity.
    """

    budget: int | None
    measure: Callable[[str], int]
    escape: Callable[[str], str]


def _identity(text: str) -> str:
    return text


def _characters(text: str) -> int:
    return len(text)


def _telegram_units(text: str) -> int:
    """The UTF-16 code units of ``text`` once Hermes has HTML-escaped it."""
    return len(html.escape(text, quote=True).encode("utf-16-le")) // 2


def _slack_escape(text: str) -> str:
    return text.translate(str.maketrans(SLACK_ENTITIES))


def _discord_escape(text: str) -> str:
    return text.translate({ord(character): f"\\{character}" for character in DISCORD_MARKUP})


def _strictest_escape(text: str) -> str:
    return _discord_escape(_slack_escape(text))


#: With no known surface named the card may be on any of them, so use the strictest budget, measure and escaping.
STRICTEST_SURFACE = Surface(DISCORD_BUDGET, _telegram_units, _strictest_escape)

#: The surfaces the plugin knows, by name.
KNOWN_SURFACES = {
    "cli": Surface(None, _characters, _identity),
    "tui": Surface(None, _characters, _identity),
    "telegram": Surface(TELEGRAM_BUDGET, _telegram_units, _identity),
    "slack": Surface(SLACK_BUDGET, _characters, _slack_escape),
}


def surface_for(name: str | None) -> Surface:
    """The surface called ``name`` (any case), or the strictest one for a name not known, none or not a string."""
    if not isinstance(name, str):
        return STRICTEST_SURFACE
    return KNOWN_SURFACES.get(name.lower(), STRICTEST_SURFACE)


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
    """What a call carries: a headline, short ``(label, value)`` facts and a ``(label, body)`` text, as ``describe`` gave them."""

    headline: str | None
    facts: tuple[tuple[str, str], ...]
    text: tuple[str, str] | None


def _parse_fact(raw: Any) -> tuple[str, str] | None:
    if not isinstance(raw, dict):
        return None
    label, value = raw.get("label"), raw.get("value")
    if not isinstance(label, str) or not label.strip() or not isinstance(value, str):
        return None
    return label, value


def _parse_text(raw: Any) -> tuple[str, str] | None:
    """The ``(label, body)`` of a text, or ``None`` for any other shape; an empty body is a text that says nothing."""
    if not isinstance(raw, dict):
        return None
    label, body = raw.get("label"), raw.get("body")
    if not isinstance(label, str) or not label.strip() or not isinstance(body, str):
        return None
    return label, body


def parse_description(raw: Any) -> Description | None:
    """The description the command line printed, or ``None`` for any other shape or for one that says nothing.

    ``{"headline"?: str, "facts": [{"label": str, "value": str}, ...], "text"?: {"label": str, "body": str}}``;
    extra keys are ignored. A headline that is not a non-blank string is
    dropped alone; a bad fact or a bad text voids the whole description. The
    command line has already marked every string; ``build_message`` marks
    again, which changes nothing.
    """
    if not isinstance(raw, dict) or not isinstance(raw.get("facts"), list):
        return None
    parsed = [_parse_fact(item) for item in raw["facts"]]
    facts = tuple(fact for fact in parsed if fact is not None)
    if len(facts) != len(parsed):
        return None
    headline = raw.get("headline")
    headline = headline if isinstance(headline, str) and headline.strip() else None
    text = None
    if "text" in raw:
        text = _parse_text(raw["text"])
        if text is None:
            return None
    if text is not None and not text[1]:
        text = None
    if headline is None and not facts and text is None:
        return None
    return Description(headline=headline, facts=facts, text=text)


def _more(count: int) -> list[str]:
    """The line that says how many facts are not shown, or no line when all are."""
    return [f"(+{count} more)"] if count else []


def _fact_line(label: str, value: str) -> str:
    return f"{label}: {value}"


def _fit_facts(surface: Surface, header: str, facts: list[tuple[str, str]]) -> list[str]:
    """The header and as many of ``facts`` as fit the budget, in order, with a ``(+N more)`` line for the rest.

    ``facts`` are marked and not escaped; the lines are escaped, and the budget
    is measured on them as joined. N counts the facts after the last one shown,
    whole or cut. When the header alone is over the budget, or leaves no room
    for the notice, only the header is shown.
    """
    budget = surface.budget

    def fits(lines: list[str]) -> bool:
        return budget is None or surface.measure("\n".join(lines)) <= budget

    def escaped_fact(label: str, value: str) -> str:
        return surface.escape(_fact_line(label, value))

    head = [surface.escape(header)]
    if not fits(head):
        return head
    shown: list[str] = []
    omitted = 0
    for index, (label, value) in enumerate(facts):
        line = escaped_fact(label, value)
        if fits([*head, *shown, line]):
            shown.append(line)
            continue
        rest = len(facts) - index - 1
        cut = _cut_value(value, lambda part: fits([*head, *shown, escaped_fact(label, part), *_more(rest)]))
        if cut is None:
            omitted = rest + 1
        else:
            shown.append(escaped_fact(label, cut))
            omitted = rest
        break
    else:
        return [*head, *shown]
    while shown and not fits([*head, *shown, *_more(omitted)]):
        shown.pop()
        omitted += 1
    lines = [*head, *shown, *_more(omitted)]
    return lines if fits(lines) else head


def _cut_value(value: str, fits: Callable[[str], bool]) -> str | None:
    """The longest prefix of ``value`` followed by ``…`` that ``fits``, cut in code points before any escaping.

    ``None`` when fewer than ``MIN_VALUE_CODE_POINTS`` code points of the value
    fit. A longer prefix never measures less, so the longest is found by bisection.
    """
    low, high = 0, len(value) - 1
    while low < high:
        middle = (low + high + 1) // 2
        if fits(value[:middle] + ELLIPSIS):
            low = middle
        else:
            high = middle - 1
    if low < MIN_VALUE_CODE_POINTS or not fits(value[:low] + ELLIPSIS):
        return None
    return value[:low] + ELLIPSIS


def build_message(header: str, description: Description | None, surface: str | None) -> str:
    """The message of the card: the header alone without a description, else the header, one line per fact and the text.

    Every piece is made ``visible`` and escaped for the surface named
    ``surface``. The header and the fact lines stay within the surface's
    budget: facts that do not fit are cut or dropped and counted in a final
    ``(+N more)`` line. The text follows after a blank line in full and is not
    counted; the surface cuts it from its end.
    """
    if description is None:
        return header
    target = surface_for(surface)
    facts = [(visible(label), visible(value)) for label, value in description.facts]
    lines = _fit_facts(target, visible(header), facts)
    if description.text is not None:
        lines += ["", target.escape(visible(description.text[1], keep_newlines=True))]
    return "\n".join(lines)
