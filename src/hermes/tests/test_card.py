"""Tests of the approval card's message: marking, surfaces, parsing a description and fitting the facts to a budget."""

from __future__ import annotations

import importlib
import unittest

from support import IMPL, ROOT_NAME

card = importlib.import_module(f"{ROOT_NAME}.{IMPL}.card")

HEADER = "Create a thing (demo_thing_create)"
BUDGETED = ("telegram", "slack", "discord", "whatsapp", None)
ALL_SURFACES = ("cli", "tui", *BUDGETED)


def described(*facts: tuple[str, str], headline: str | None = None, text: str | None = None) -> object:
    return card.Description(headline=headline, facts=tuple(facts), text=None if text is None else ("Text", text))


class VisibleTest(unittest.TestCase):
    def test_marks_what_can_forge_a_line_or_hide_a_value(self) -> None:
        marks = {
            "\t": "<U+0009>",
            "\n": "<U+000A>",
            "\r": "<U+000D>",
            "\u007f": "<U+007F>",
            "\u0085": "<U+0085>",
            "\u202e": "<U+202E>",
            "\u2066": "<U+2066>",
            "\u200b": "<U+200B>",
            "\u200d": "<U+200D>",
            "\ufeff": "<U+FEFF>",
            "\u00ad": "<U+00AD>",
            "\u2028": "<U+2028>",
            "\u2029": "<U+2029>",
            "\U000e0041": "<U+E0041>",
            "\u3164": "<U+3164>",
            "\u115f": "<U+115F>",
            "\u1160": "<U+1160>",
            "\uffa0": "<U+FFA0>",
            "\u034f": "<U+034F>",
            "\u17b4": "<U+17B4>",
            "\u180b": "<U+180B>",
            "\ufe0f": "<U+FE0F>",
            "\ufff0": "<U+FFF0>",
            "\U0001bca0": "<U+1BCA0>",
            "\U0001d173": "<U+1D173>",
            "\U000e0100": "<U+E0100>",
            "\ud800": "<U+D800>",
        }
        for character, mark in marks.items():
            with self.subTest(mark=mark):
                self.assertEqual(card.visible(f"a{character}b"), f"a{mark}b")

    def test_keeps_spaces_visible_text_and_emoji(self) -> None:
        for text in ("a b", "\u00a0", "\u3000", "日本語", "😀", "e\u0301"):
            with self.subTest(text=text):
                self.assertEqual(card.visible(text), text)

    def test_pads_the_hex_to_four_digits_and_no_further(self) -> None:
        self.assertEqual(card.visible("\u0001"), "<U+0001>")
        self.assertEqual(card.visible("\U000e0001"), "<U+E0001>")

    def test_marks_each_lone_surrogate(self) -> None:
        self.assertEqual(card.visible("\ud800\ud800"), "<U+D800><U+D800>")
        self.assertEqual(card.visible("\udc00😀"), "<U+DC00>😀")

    def test_keep_newlines_keeps_newline_turns_crlf_into_it_and_marks_a_lone_cr(self) -> None:
        self.assertEqual(card.visible("a\nb\r\nc\rd\t", keep_newlines=True), "a\nb\nc<U+000D>d<U+0009>")
        self.assertEqual(card.visible("a\r\nb"), "a<U+000D><U+000A>b")

    def test_is_idempotent(self) -> None:
        text = "a\u202e\r\nb\ud800\u200d\U000e0041\n"
        for keep_newlines in (False, True):
            with self.subTest(keep_newlines=keep_newlines):
                once = card.visible(text, keep_newlines)
                self.assertEqual(card.visible(once, keep_newlines), once)


class ParseDescriptionTest(unittest.TestCase):
    def test_reads_headline_facts_and_text(self) -> None:
        parsed = card.parse_description(
            {
                "headline": 'Create the note "todo"',
                "facts": [{"label": "Kind", "value": "group"}, {"label": "Size", "value": ""}],
                "text": {"label": "Note text", "body": "hi"},
            }
        )
        self.assertEqual(
            parsed,
            card.Description(
                headline='Create the note "todo"',
                facts=(("Kind", "group"), ("Size", "")),
                text=("Note text", "hi"),
            ),
        )

    def test_headline_and_text_are_optional_and_each_part_can_stand_alone(self) -> None:
        fact = {"label": "a", "value": "b"}
        self.assertEqual(card.parse_description({"facts": [fact]}), described(("a", "b")))
        self.assertEqual(card.parse_description({"headline": "h", "facts": []}), described(headline="h"))
        self.assertEqual(
            card.parse_description({"facts": [], "text": {"label": "Text", "body": "t"}}), described(text="t")
        )

    def test_an_empty_body_drops_the_text(self) -> None:
        fact = {"label": "a", "value": "b"}
        self.assertEqual(
            card.parse_description({"facts": [fact], "text": {"label": "L", "body": ""}}), described(("a", "b"))
        )
        self.assertIsNone(card.parse_description({"facts": [], "text": {"label": "L", "body": ""}}))

    def test_a_bad_headline_is_dropped_alone(self) -> None:
        for headline in (5, None, "", "  ", [], {"text": "h"}):
            with self.subTest(headline=headline):
                parsed = card.parse_description({"headline": headline, "facts": [{"label": "a", "value": "b"}]})
                self.assertEqual(parsed, described(("a", "b")))
                self.assertIsNone(card.parse_description({"headline": headline, "facts": []}))

    def test_ignores_extra_keys(self) -> None:
        parsed = card.parse_description({"facts": [{"label": "a", "value": "b", "x": 1}], "y": 2})
        self.assertEqual(parsed, described(("a", "b")))
        parsed = card.parse_description({"facts": [], "text": {"label": "Text", "body": "t", "x": 1}})
        self.assertEqual(parsed, described(text="t"))

    def test_anything_else_is_none(self) -> None:
        bad = [
            None,
            [],
            "text",
            5,
            {},
            {"headline": "h"},
            {"facts": "x"},
            {"facts": None},
            {"facts": []},
            {"facts": [], "text": None},
            {"facts": [], "text": ""},
            {"facts": [1]},
            {"facts": [{"label": "a", "value": "b"}, "x"]},
            {"facts": [{"label": " ", "value": "v"}]},
            {"facts": [{"label": "", "value": "v"}]},
            {"facts": [{"label": 1, "value": "v"}]},
            {"facts": [{"label": "a", "value": 1}]},
            {"facts": [{"label": "a"}]},
            {"facts": [{"value": "v"}]},
            {"headline": "h", "facts": [{"label": "a", "value": 1}]},
            {"headline": "h", "facts": [{"label": "a", "value": "b"}], "text": 5},
            {"facts": [{"label": "a", "value": "b"}], "text": "t"},
            {"facts": [{"label": "a", "value": "b"}], "text": None},
            {"facts": [{"label": "a", "value": "b"}], "text": []},
            {"facts": [{"label": "a", "value": "b"}], "text": {"body": "t"}},
            {"facts": [{"label": "a", "value": "b"}], "text": {"label": "L"}},
            {"facts": [{"label": " ", "value": "b"}], "text": {"label": "L", "body": "t"}},
            {"facts": [{"label": "a", "value": "b"}], "text": {"label": " ", "body": "t"}},
            {"facts": [{"label": "a", "value": "b"}], "text": {"label": 1, "body": "t"}},
            {"facts": [{"label": "a", "value": "b"}], "text": {"label": "L", "body": 1}},
        ]
        for raw in bad:
            with self.subTest(raw=raw):
                self.assertIsNone(card.parse_description(raw))


class SurfaceTest(unittest.TestCase):
    def test_the_command_line_surfaces_have_no_budget_and_no_escaping(self) -> None:
        for name in ("cli", "tui"):
            surface = card.surface_for(name)
            self.assertIsNone(surface.budget)
            self.assertEqual(surface.escape("<&>[x](y) @everyone"), "<&>[x](y) @everyone")

    def test_telegram_measures_the_html_escaped_text_in_utf16_units_and_escapes_nothing(self) -> None:
        surface = card.surface_for("telegram")
        self.assertEqual(surface.budget, 500)
        self.assertEqual(surface.escape("<b>&"), "<b>&")
        self.assertEqual(surface.measure("a"), 1)
        self.assertEqual(surface.measure("&"), len("&amp;"))
        self.assertEqual(surface.measure('"'), len("&quot;"))
        self.assertEqual(surface.measure("😀"), 2)

    def test_slack_counts_characters_and_escapes_the_mrkdwn_entities(self) -> None:
        surface = card.surface_for("slack")
        self.assertEqual(surface.budget, 500)
        self.assertEqual(surface.measure("😀"), 1)
        self.assertEqual(
            surface.escape("<!channel> & <@U1> <http://x|y>"), "&lt;!channel&gt; &amp; &lt;@U1&gt; &lt;http://x|y&gt;"
        )
        self.assertEqual(surface.escape("&lt;"), "&amp;lt;")

    def test_every_other_name_and_none_get_the_strictest(self) -> None:
        for name in ("discord", "desktop", "acp", "whatsapp", "", "unheard-of", None, 5, b"cli"):
            with self.subTest(name=name):
                self.assertIs(card.surface_for(name), card.STRICTEST_SURFACE)
        self.assertEqual(card.STRICTEST_SURFACE.budget, 300)
        self.assertEqual(card.STRICTEST_SURFACE.measure("😀"), 2)
        self.assertEqual(card.STRICTEST_SURFACE.measure("&"), len("&amp;"))

    def test_names_are_compared_lowercased(self) -> None:
        self.assertIs(card.surface_for("CLI"), card.surface_for("cli"))
        self.assertIs(card.surface_for("Telegram"), card.surface_for("telegram"))
        self.assertIs(card.surface_for("SLACK"), card.surface_for("slack"))

    def test_strictest_escapes_slack_entities_then_discord_markup(self) -> None:
        escape = card.STRICTEST_SURFACE.escape
        for character in "\\*_~`|[]()#-@":
            with self.subTest(character=character):
                self.assertEqual(escape(f"a{character}b"), f"a\\{character}b")
        self.assertEqual(escape("\\*"), "\\\\\\*")
        self.assertEqual(escape("<@everyone> &"), "&lt;\\@everyone&gt; &amp;")
        self.assertEqual(escape("plain: text. 1/2"), "plain: text. 1/2")


class BuildMessageTest(unittest.TestCase):
    def fact_part(self, message: str) -> str:
        return message.split("\n\n", 1)[0]

    def test_without_a_description_it_is_the_header_unchanged_for_every_surface(self) -> None:
        header = "Create <b>[x](y)</b> & @everyone (demo_thing_create)"
        for surface in (*ALL_SURFACES, "CLI", 5):
            with self.subTest(surface=surface):
                self.assertEqual(card.build_message(header, None, surface), header)

    def test_cli_and_tui_show_everything_in_full(self) -> None:
        facts = [(f"Label {n}", "v" * 200) for n in range(20)]
        text = "t" * 5000
        for surface in ("cli", "tui"):
            with self.subTest(surface=surface):
                expected = "\n".join([HEADER, *(f"{label}: {value}" for label, value in facts), "", text])
                self.assertEqual(card.build_message(HEADER, described(*facts, text=text), surface), expected)

    def test_layout_is_header_then_facts_then_a_blank_line_and_the_text(self) -> None:
        message = card.build_message(
            HEADER, described(("Kind", "group"), ("Size", "3 KB"), text="hello\nworld"), "cli"
        )
        self.assertEqual(message, f"{HEADER}\nKind: group\nSize: 3 KB\n\nhello\nworld")

    def test_a_description_of_a_text_only_and_of_facts_only(self) -> None:
        self.assertEqual(card.build_message("H", described(text="t"), "cli"), "H\n\nt")
        self.assertEqual(card.build_message("H", described(("a", "b")), "cli"), "H\na: b")

    def test_marks_header_labels_values_and_text(self) -> None:
        message = card.build_message(
            "a\u202eb", described(("la\tbel", "x\ny\r\nz"), text="p\r\nq\rr\u200bs"), "cli"
        )
        self.assertEqual(message, "a<U+202E>b\nla<U+0009>bel: x<U+000A>y<U+000D><U+000A>z\n\np\nq<U+000D>r<U+200B>s")

    def test_slack_escapes_mentions_links_and_ampersands(self) -> None:
        message = card.build_message(
            "H & <J>", described(("Chat <!channel>", "<@U1> & <http://x|y>"), text="<!here>"), "slack"
        )
        self.assertEqual(
            message,
            "H &amp; &lt;J&gt;\nChat &lt;!channel&gt;: &lt;@U1&gt; &amp; &lt;http://x|y&gt;\n\n&lt;!here&gt;",
        )

    def test_discord_escapes_links_mentions_and_emphasis(self) -> None:
        message = card.build_message(
            "A_B", described(("Link", "[x](http://e)"), ("Who", "@everyone a_b"), text="# t *b*"), "discord"
        )
        self.assertEqual(
            message,
            "A\\_B\nLink: \\[x\\]\\(http://e\\)\nWho: \\@everyone a\\_b\n\n\\# t \\*b\\*",
        )

    def test_an_unknown_or_missing_surface_gets_the_strictest_rules_and_budget(self) -> None:
        facts = [(f"Label {n}", "[v]" * 30) for n in range(20)]
        expected = card.build_message(HEADER, described(*facts), "discord")
        for surface in (None, "desktop", "acp", 5):
            with self.subTest(surface=surface):
                message = card.build_message(HEADER, described(*facts), surface)
                self.assertEqual(message, expected)
                self.assertLessEqual(len(message), 300)
                self.assertIn("\\[v\\]", message)

    def test_telegram_is_not_escaped(self) -> None:
        message = card.build_message("H", described(("a", "<b>&[x](y)@all")), "telegram")
        self.assertEqual(message, "H\na: <b>&[x](y)@all")

    def test_the_budget_holds_for_many_facts_and_facts_keep_their_order(self) -> None:
        facts = [(f"Label {n}", "v" * 30) for n in range(40)]
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                target = card.surface_for(surface)
                message = card.build_message(HEADER, described(*facts), surface)
                self.assertLessEqual(target.measure(message), target.budget)
                lines = message.split("\n")
                shown = lines[1:-1]
                self.assertEqual(shown, [f"{label}: {value}" for label, value in facts[: len(shown)]])
                self.assertEqual(lines[-1], f"(+{len(facts) - len(shown)} more)")

    def test_facts_that_all_fit_have_no_more_line(self) -> None:
        facts = [("a", "b"), ("c", "d")]
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                self.assertEqual(card.build_message("H", described(*facts), surface), "H\na: b\nc: d")

    def test_a_long_value_is_cut_with_an_ellipsis_and_followed_by_the_count_of_the_rest(self) -> None:
        message = card.build_message("H", described(("A", "a"), ("B", "b" * 1000), ("C", "c")), "slack")
        self.assertEqual(message, "H\nA: a\nB: " + "b" * 479 + "…\n(+1 more)")
        self.assertEqual(len(message), 500)

    def test_a_cut_last_fact_has_no_more_line(self) -> None:
        message = card.build_message("H", described(("A", "a"), ("B", "b" * 1000)), "slack")
        self.assertEqual(message, "H\nA: a\nB: " + "b" * 489 + "…")
        self.assertEqual(len(message), 500)

    def test_a_fact_that_keeps_fewer_than_eight_code_points_is_dropped(self) -> None:
        # "H\nA: " and 285 characters leave room for 5 characters of the next value.
        message = card.build_message("H", described(("A", "a" * 285), ("B", "b" * 100), ("C", "c")), "discord")
        self.assertEqual(message, "H\nA: " + "a" * 285 + "\n(+2 more)")
        self.assertEqual(len(message), 300)

    def test_a_fact_that_keeps_exactly_eight_code_points_is_cut(self) -> None:
        # "H\nA: ", 282 characters and "\nB: " leave room for 8 characters and the ellipsis.
        message = card.build_message("H", described(("A", "a" * 282), ("B", "b" * 100)), "discord")
        self.assertEqual(message, "H\nA: " + "a" * 282 + "\nB: " + "b" * 8 + "…")
        self.assertEqual(len(message), 300)

    def test_shown_facts_are_removed_from_the_end_until_the_more_line_fits(self) -> None:
        message = card.build_message("H", described(("A", "a" * 292), ("B", "b" * 100)), "discord")
        self.assertEqual(message, "H\n(+2 more)")

    def test_a_header_over_the_budget_shows_no_fact(self) -> None:
        header = "x" * 400
        message = card.build_message(header, described(("A", "a"), ("B", "b"), text="t"), "discord")
        self.assertEqual(message, f"{header}\n\nt")
        self.assertEqual(card.build_message(header, described(text="t"), "discord"), f"{header}\n\nt")

    def test_a_header_that_leaves_no_room_for_the_more_line_is_shown_alone(self) -> None:
        header = "x" * 299
        self.assertEqual(card.build_message(header, described(("A", "b")), "discord"), header)

    def test_the_text_follows_in_full_and_is_not_counted_against_the_budget(self) -> None:
        facts = [(f"Label {n}", "v" * 30) for n in range(40)]
        text = "line one\n" + "t" * 5000
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                without = card.build_message(HEADER, described(*facts), surface)
                message = card.build_message(HEADER, described(*facts, text=text), surface)
                self.assertEqual(message, f"{without}\n\n{text}")
                self.assertEqual(self.fact_part(message), without)

    def test_telegram_measures_after_the_html_escape(self) -> None:
        message = card.build_message("H", described(("A", "&" * 600)), "telegram")
        # "H\nA: " is 5 units, "…" one, and each "&" is the 5 units of "&amp;".
        self.assertEqual(message, "H\nA: " + "&" * 98 + "…")
        self.assertLessEqual(card.surface_for("telegram").measure(message), 500)
        self.assertGreater(card.surface_for("telegram").measure(message.replace("…", "&&…")), 500)

    def test_telegram_measures_in_utf16_units_and_never_splits_a_surrogate_pair(self) -> None:
        message = card.build_message("H", described(("A", "😀" * 600)), "telegram")
        self.assertEqual(message, "H\nA: " + "😀" * 247 + "…")
        self.assertLessEqual(card.surface_for("telegram").measure(message), 500)
        message.encode("utf-16-le")

    def test_a_missing_surface_fits_entities_within_the_strictest_telegram_units(self) -> None:
        message = card.build_message("H", described(("A", "&" * 200)), None)
        self.assertLessEqual(card.surface_for("telegram").measure(self.fact_part(message)), 300)
        self.assertTrue(message.endswith("…"))
        self.assertNotIn("&amp;" * 200, message)

    def test_a_lone_surrogate_is_marked_before_it_is_measured(self) -> None:
        message = card.build_message("H\ud800", described(("A\udc00", "\ud800" * 600), text="\ud83d"), "telegram")
        message.encode("utf-16-le")
        self.assertIn("<U+D800>", message)
        self.assertLessEqual(card.surface_for("telegram").measure(self.fact_part(message)), 500)

    def test_escapes_are_measured_and_never_split_by_a_cut(self) -> None:
        for surface, escaped in (("slack", "&lt;"), ("discord", "&lt;")):
            with self.subTest(surface=surface):
                target = card.surface_for(surface)
                message = card.build_message("H", described(("A", "<" * 1000)), surface)
                self.assertLessEqual(target.measure(message), target.budget)
                value = message.split(": ", 1)[1]
                self.assertTrue(value.endswith("…"))
                body = value[:-1]
                self.assertEqual(body, escaped * (len(body) // len(escaped)))

    def test_the_value_is_the_longest_prefix_that_fits(self) -> None:
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                target = card.surface_for(surface)
                value = "ab&<[" * 200
                message = card.build_message("H", described(("A", value)), surface)
                self.assertEqual(message, self.longest_cut(target, value))

    def longest_cut(self, target: object, value: str) -> str:
        """The card for one fact with the longest prefix of ``value`` that fits, found by trying each length."""
        fitting = [
            message
            for size in range(len(value))
            if target.measure(message := target.escape(f"H\nA: {value[:size]}…")) <= target.budget
        ]
        return fitting[-1]


if __name__ == "__main__":
    unittest.main()
