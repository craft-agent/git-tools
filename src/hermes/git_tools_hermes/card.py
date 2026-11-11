"""The message of the approval card: the headline, the targets and what the call carries, fitted to the surface it is shown on."""

from __future__ import annotations

import html
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

#: The name of the card's section that lists the targets and the facts; the plugin's own word, in English.
DETAILS_HEADING = "Details"

#: The label of a target's line in the Details; the plugin's own word, in English.
TARGET_LABEL = "Target"

#: The notice of the facts that are not shown, in English; ``{count}`` stands for how many.
MORE_NOTICE = "(+{count} more)"

#: The notice of the characters a cut value or text leaves out, in English, for one character; ``{count}`` stands for how many.
MORE_CHARACTER_NOTICE = "(+{count} more character)"

#: The same notice for any other count.
MORE_CHARACTERS_NOTICE = "(+{count} more characters)"

#: Where the number goes in the notice.
COUNT_PLACEHOLDER = "{count}"

#: What a target is when the resource a call writes to cannot be told; the card names no target for it.
ANY_RESOURCE = "*"

#: The budget, in UTF-16 code units of the HTML-escaped text, of the Telegram card;
#: Hermes escapes it and cuts it from the end.
TELEGRAM_BUDGET = 500

#: The budget, in characters, of the Slack card; Hermes cuts it from the end.
SLACK_BUDGET = 500

#: The budget, in characters, of the Discord card, which is also the strictest one; Hermes cuts it from the end.
DISCORD_BUDGET = 300

#: The names of the surfaces Hermes shows a card on without cutting it or rendering markup in it: its own clients.
PLAIN_SURFACE_NAMES = ("cli", "tui", "desktop", "acp")

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


#: With no surface named the card may be on any of them, so use the strictest budget, measure and escaping.
STRICTEST_SURFACE = Surface(DISCORD_BUDGET, _telegram_units, _strictest_escape)

#: A surface Hermes does not cut: the card is shown in full and as written.
PLAIN_SURFACE = Surface(None, _characters, _identity)

#: A surface Hermes names that the plugin does not know: Hermes does not cut it, but it may render markup.
UNKNOWN_SURFACE = Surface(None, _characters, _strictest_escape)

#: The surfaces the plugin knows, by name.
KNOWN_SURFACES = {
    **{name: PLAIN_SURFACE for name in PLAIN_SURFACE_NAMES},
    "telegram": Surface(TELEGRAM_BUDGET, _telegram_units, _identity),
    "slack": Surface(SLACK_BUDGET, _characters, _slack_escape),
    "discord": Surface(DISCORD_BUDGET, _characters, _discord_escape),
}


def surface_for(name: str | None) -> Surface:
    """The surface called ``name`` (any case).

    Hermes cuts the card only on the surfaces the plugin knows, so any other
    name gets no budget; it may still render markup, so it gets the strictest
    escaping. A card whose surface cannot be told (none, empty or not a
    string) gets the strictest one.
    """
    if not isinstance(name, str) or not name:
        return STRICTEST_SURFACE
    return KNOWN_SURFACES.get(name.lower(), UNKNOWN_SURFACE)


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
    """What a call carries: a headline, short ``(label, value)`` facts and a ``(label, body)`` text, as ``describe`` gave them.

    ``fact_omitted`` holds, per fact, the code points the tool's cut left out of its value, or is empty when no
    value was cut; ``text_omitted`` is the same for the text (0 for none).
    """

    headline: str | None
    facts: tuple[tuple[str, str], ...]
    text: tuple[str, str] | None
    fact_omitted: tuple[int, ...] = ()
    text_omitted: int = 0


def _parse_omitted(raw: Any) -> int:
    """How many code points a cut left out: ``raw`` when it is a positive integer, else 0 (never an error)."""
    return raw if isinstance(raw, int) and not isinstance(raw, bool) and raw > 0 else 0


def _parse_fact(raw: Any) -> tuple[str, str, int] | None:
    if not isinstance(raw, dict):
        return None
    label, value = raw.get("label"), raw.get("value")
    if not isinstance(label, str) or not label.strip() or not isinstance(value, str):
        return None
    return label, value, _parse_omitted(raw.get("omitted"))


def _parse_text(raw: Any) -> tuple[str, str, int] | None:
    """The ``(label, body, omitted)`` of a text, or ``None`` for any other shape; an empty body is a text that says nothing."""
    if not isinstance(raw, dict):
        return None
    label, body = raw.get("label"), raw.get("body")
    if not isinstance(label, str) or not label.strip() or not isinstance(body, str):
        return None
    return label, body, _parse_omitted(raw.get("omitted"))


def parse_description(raw: Any) -> Description | None:
    """The description the command line printed, or ``None`` for any other shape or for one that says nothing.

    ``{"headline"?: str, "facts": [{"label": str, "value": str, "omitted"?: int}, ...], "text"?: {"label": str,
    "body": str, "omitted"?: int}}``; extra keys are ignored. A headline that
    is not a non-blank string is dropped alone, and so is an ``omitted`` that
    is not a positive integer; a bad fact or a bad text voids the whole
    description. The command line has already marked every string;
    ``build_message`` marks again, which changes nothing.
    """
    if not isinstance(raw, dict) or not isinstance(raw.get("facts"), list):
        return None
    parsed = [_parse_fact(item) for item in raw["facts"]]
    entries = [fact for fact in parsed if fact is not None]
    if len(entries) != len(parsed):
        return None
    facts = tuple((label, value) for label, value, _ in entries)
    fact_omitted = tuple(omitted for _, _, omitted in entries)
    headline = raw.get("headline")
    headline = headline if isinstance(headline, str) and headline.strip() else None
    text = None
    text_omitted = 0
    if "text" in raw:
        parsed_text = _parse_text(raw["text"])
        if parsed_text is None:
            return None
        text, text_omitted = parsed_text[:2], parsed_text[2]
    if text is not None and not text[1]:
        text, text_omitted = None, 0
    if headline is None and not facts and text is None:
        return None
    return Description(
        headline=headline,
        facts=facts,
        text=text,
        fact_omitted=fact_omitted if any(fact_omitted) else (),
        text_omitted=text_omitted,
    )


@dataclass(frozen=True)
class Words:
    """The plugin's own words of the card, in one language: the Details heading, the Target label and the notices.

    ``more`` (the facts not shown), ``more_character`` (one character a cut
    left out) and ``more_characters`` (any other count) hold ``{count}`` once.
    """

    details: str
    target: str
    more: str
    more_character: str
    more_characters: str


#: The words in English, which the card uses when the command line gave no others or gave bad ones.
ENGLISH_WORDS = Words(DETAILS_HEADING, TARGET_LABEL, MORE_NOTICE, MORE_CHARACTER_NOTICE, MORE_CHARACTERS_NOTICE)


def _is_word(raw: Any) -> bool:
    return isinstance(raw, str) and bool(raw.strip())


def _is_notice(raw: Any) -> bool:
    """Whether ``raw`` is a word that holds ``{count}`` once and no other brace."""
    if not _is_word(raw) or raw.count(COUNT_PLACEHOLDER) != 1:
        return False
    rest = raw.replace(COUNT_PLACEHOLDER, "")
    return "{" not in rest and "}" not in rest


def parse_line(raw: Any) -> str | None:
    """The translated title or intent the command line printed, or ``None`` for anything but a non-blank string."""
    return raw if _is_word(raw) else None


def parse_words(raw: Any) -> Words:
    """The words the command line printed, or the English ones when any of the five is missing or bad.

    ``{"details": str, "target": str, "more": str, "more_character": str,
    "more_characters": str}`` with non-blank strings and ``{count}`` once in
    each notice; extra keys are ignored. The command line has already marked
    every string; ``build_message`` marks again, which changes nothing.
    """
    if not isinstance(raw, dict) or not _is_word(raw.get("details")) or not _is_word(raw.get("target")):
        return ENGLISH_WORDS
    notices = ("more", "more_character", "more_characters")
    if not all(_is_notice(raw.get(name)) for name in notices):
        return ENGLISH_WORDS
    return Words(details=raw["details"], target=raw["target"], **{name: raw[name] for name in notices})


def _own_word(surface: Surface, word: str, english: str) -> str:
    """``word`` as the card shows it: the English word as it is, any other made ``visible`` and escaped for ``surface``."""
    return word if word == english else surface.escape(visible(word))


def _shown_words(surface: Surface, words: Words) -> Words:
    return Words(
        details=_own_word(surface, words.details, ENGLISH_WORDS.details),
        target=_own_word(surface, words.target, ENGLISH_WORDS.target),
        more=_own_word(surface, words.more, ENGLISH_WORDS.more),
        more_character=_own_word(surface, words.more_character, ENGLISH_WORDS.more_character),
        more_characters=_own_word(surface, words.more_characters, ENGLISH_WORDS.more_characters),
    )


def _more(count: int, words: Words) -> list[str]:
    """The line that says how many facts are not shown, or no line when all are."""
    return [words.more.replace(COUNT_PLACEHOLDER, str(count))] if count else []


def _characters_left_out(count: int, words: Words) -> str:
    """The notice of the ``count`` characters a cut left out, in its singular form for one."""
    notice = words.more_character if count == 1 else words.more_characters
    return notice.replace(COUNT_PLACEHOLDER, str(count))


def _fact_line(label: str, value: str) -> str:
    return f"{label}: {value}"


def _section_heading(name: str) -> str:
    return f"--- {name} ---"


def _fit_facts(
    surface: Surface, first: str, targets: list[str], facts: list[tuple[str, str, int]], words: Words
) -> list[str]:
    """The head and as many of ``facts`` as fit the budget, in order, with a notice line (``words.more``) for the rest.

    The head is the first line, then the Details section's frame and the
    ``targets`` (never cut or dropped); with no target the frame comes only
    with a fact or the notice. ``first``, ``targets`` and ``words`` are
    escaped; ``facts`` are ``(label, value, left_out)``, marked and not
    escaped. The lines are escaped, and the budget is measured on them as
    joined, with the words as given. N counts the facts after the last one
    shown, whole or cut. When the head alone is over the budget, or leaves no
    room for the notice, no fact is shown and the notice still is, past the
    budget: facts are never left out without a word.

    A whole value the tool cut (``left_out`` characters) is followed by the
    notice of those characters when the line still fits; a value the budget
    cuts further ends in ``…`` alone, and a notice that does not fit is left
    out before its fact is dropped.
    """
    budget = surface.budget

    def fits(lines: list[str]) -> bool:
        return budget is None or surface.measure("\n".join(lines)) <= budget

    def compose(details: list[str]) -> list[str]:
        if not targets and not details:
            return [first]
        return [first, "", _section_heading(words.details), "", *targets, *details]

    def escaped_fact(label: str, value: str) -> str:
        return surface.escape(_fact_line(label, value))

    def lines_of(entries: list[tuple[str, str]]) -> list[str]:
        return [line for line, _ in entries]

    head = compose([])
    if not fits(head):
        return compose(_more(len(facts), words))
    # Each shown fact is its line and the line without the notice of the characters the tool left out.
    shown: list[tuple[str, str]] = []
    omitted = 0
    for index, (label, value, left_out) in enumerate(facts):
        bare = escaped_fact(label, value)
        candidates = [f"{bare} {_characters_left_out(left_out, words)}", bare] if left_out else [bare]
        whole = next((line for line in candidates if fits(compose([*lines_of(shown), line]))), None)
        if whole is not None:
            shown.append((whole, bare))
            continue
        rest = len(facts) - index - 1
        cut = _cut_value(
            value, lambda part: fits(compose([*lines_of(shown), escaped_fact(label, part), *_more(rest, words)]))
        )
        if cut is None:
            omitted = rest + 1
        else:
            line = escaped_fact(label, cut)
            shown.append((line, line))
            omitted = rest
        break
    else:
        return compose(lines_of(shown))
    while shown and not fits(compose([*lines_of(shown), *_more(omitted, words)])):
        line, bare = shown[-1]
        if line != bare:
            shown[-1] = (bare, bare)
        else:
            shown.pop()
            omitted += 1
    return compose([*lines_of(shown), *_more(omitted, words)])


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


def _head_fits(surface: Surface, first: str, targets: list[str], words: Words) -> bool:
    """Whether the first line and every Target line, with the Details frame, fit the surface's budget."""
    if surface.budget is None:
        return True
    lines = [first, "", _section_heading(words.details), "", *targets] if targets else [first]
    return surface.measure("\n".join(lines)) <= surface.budget


def build_message(
    stand_in: str,
    resources: list[str],
    description: Description | None,
    surface: str | None,
    words: Words = ENGLISH_WORDS,
) -> str:
    """The message of the card, in the shape of ``approvalPrompt`` in ``src/entry/description.ts``.

    The headline (``stand_in`` without one: the line the caller chose, an
    intent or a title); a Details section with a ``Target`` line per resource,
    unless the only resource is ``*`` (what cannot be told), then one line per
    fact; and the text under its own label, followed by the notice of the
    characters the tool's cut left out of it, if any. A section with nothing
    to show is left out. The plugin's own words (the Details heading, the
    ``Target`` label, the notice of the facts not shown and the notices of
    the characters left out) are ``words``.

    Every piece that is not the plugin's own English words is made ``visible``
    and escaped for the surface named ``surface``, ``words`` of another
    language included; the section frames and the ``: `` after the label are
    not. The first line, the Details frame, the targets and the fact lines
    stay within the surface's budget, measured with ``words``: the targets are
    never cut or dropped, facts that do not fit are cut or dropped and counted
    in a notice line. The text section is not counted; the surface cuts it
    from its end.
    """
    target = surface_for(surface)
    shown = _shown_words(target, words)
    named = [] if resources == [ANY_RESOURCE] else resources
    targets = [f"{shown.target}: {target.escape(visible(resource))}" for resource in named]
    first = target.escape(visible(stand_in))
    if description and description.headline:
        headline = target.escape(visible(description.headline))
        # A headline that would push a target past the cut gives way to the stand-in: the targets are what an
        # "always" answer stores, so they must stay in sight.
        if _head_fits(target, headline, targets, shown) or not _head_fits(target, first, targets, shown):
            first = headline
    facts = []
    if description:
        left_out = description.fact_omitted or (0,) * len(description.facts)
        facts = [(visible(label), visible(value), count) for (label, value), count in zip(description.facts, left_out)]
    lines = _fit_facts(target, first, targets, facts, shown)
    if description and description.text is not None:
        label, body = description.text
        lines += [
            "",
            _section_heading(target.escape(visible(label))),
            "",
            target.escape(visible(body, keep_newlines=True)),
        ]
        if description.text_omitted:
            lines.append(_characters_left_out(description.text_omitted, shown))
    return "\n".join(lines)
