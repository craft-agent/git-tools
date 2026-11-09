"""Tests of the approval card's message: marking, surfaces, parsing a description and fitting the facts to a budget."""

from __future__ import annotations

import importlib
import unittest

from support import IMPL, ROOT_NAME

card = importlib.import_module(f"{ROOT_NAME}.{IMPL}.card")

TITLE = "Create a thing"
BUDGETED = ("telegram", "slack", "discord", "whatsapp", None)
ALL_SURFACES = ("cli", "tui", *BUDGETED)
DETAILS = "\n\n--- Details ---\n\n"
JAPANESE = card.Words(details="詳細", target="対象", more="（ほか {count} 件）")


def described(
    *facts: tuple[str, str], headline: str | None = None, text: tuple[str, str] | None = None
) -> object:
    return card.Description(headline=headline, facts=tuple(facts), text=text)


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
            card.parse_description({"facts": [], "text": {"label": "L", "body": "t"}}), described(text=("L", "t"))
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
        parsed = card.parse_description({"facts": [], "text": {"label": "L", "body": "t", "x": 1}})
        self.assertEqual(parsed, described(text=("L", "t")))

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


class ParseWordsTest(unittest.TestCase):
    GOOD = {"details": "詳細", "target": "対象", "more": "（ほか {count} 件）"}

    def test_reads_the_three_words(self) -> None:
        self.assertEqual(card.parse_words(self.GOOD), JAPANESE)
        self.assertEqual(card.parse_words({**self.GOOD, "x": 1}), JAPANESE)

    def test_english_is_the_words_of_the_constants(self) -> None:
        self.assertEqual(card.ENGLISH_WORDS, card.Words("Details", "Target", "(+{count} more)"))

    def test_any_bad_word_gives_the_english_ones(self) -> None:
        bad = [
            None,
            [],
            "words",
            {},
            {k: v for k, v in self.GOOD.items() if k != "details"},
            {k: v for k, v in self.GOOD.items() if k != "target"},
            {k: v for k, v in self.GOOD.items() if k != "more"},
            {**self.GOOD, "details": ""},
            {**self.GOOD, "target": "  "},
            {**self.GOOD, "more": ""},
            {**self.GOOD, "details": 1},
            {**self.GOOD, "target": None},
            {**self.GOOD, "more": ["{count}"]},
            {**self.GOOD, "more": "ほか 件"},
            {**self.GOOD, "more": "{count} と {count}"},
            {**self.GOOD, "more": "{count} {name}"},
            {**self.GOOD, "more": "{count} {"},
            {**self.GOOD, "more": "{count} }"},
            {**self.GOOD, "more": "{{count}}"},
            {**self.GOOD, "more": "{ count }"},
            {**self.GOOD, "more": "{0}"},
        ]
        for raw in bad:
            with self.subTest(raw=raw):
                self.assertIs(card.parse_words(raw), card.ENGLISH_WORDS)

    def test_a_title_or_intent_is_a_non_blank_string_or_nothing(self) -> None:
        self.assertEqual(card.parse_line("メモを作成する"), "メモを作成する")
        for raw in (None, "", "  ", 3, ["t"], {"title": "t"}):
            with self.subTest(raw=raw):
                self.assertIsNone(card.parse_line(raw))


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
    def head_of(self, message: str) -> str:
        """The message without its text section."""
        return message.split("\n\n--- Note ---", 1)[0]

    def test_cli_and_tui_draw_the_one_shape_of_the_conventions(self) -> None:
        description = described(
            ("Size", "42 bytes"), headline='Create the note "todo"', text=("Note text", "# Todo")
        )
        expected = "\n".join(
            [
                'Create the note "todo"',
                "",
                "--- Details ---",
                "",
                "Target: /work/tree/notes/todo.md",
                "Size: 42 bytes",
                "",
                "--- Note text ---",
                "",
                "# Todo",
            ]
        )
        for surface in ("cli", "tui"):
            with self.subTest(surface=surface):
                message = card.build_message("Create a note", ["/work/tree/notes/todo.md"], description, surface)
                self.assertEqual(message, expected)

    def test_without_a_description_it_is_the_title_and_a_target_line_per_resource(self) -> None:
        for surface in (*ALL_SURFACES, "CLI", 5):
            with self.subTest(surface=surface):
                message = card.build_message(TITLE, ["a", "b"], None, surface)
                self.assertEqual(message, f"{TITLE}{DETAILS}Target: a\nTarget: b")

    def test_resources_that_cannot_be_told_leave_the_title_alone(self) -> None:
        for description in (None, described()):
            with self.subTest(description=description):
                self.assertEqual(card.build_message("Update a <widget>", ["*"], description, "cli"), "Update a <widget>")
                self.assertEqual(
                    card.build_message("Update a <widget>", ["*"], description, "slack"), "Update a &lt;widget&gt;"
                )

    def test_a_star_beside_named_resources_is_shown(self) -> None:
        self.assertEqual(card.build_message(TITLE, ["a", "*"], None, "cli"), f"{TITLE}{DETAILS}Target: a\nTarget: *")
        self.assertEqual(card.build_message(TITLE, ["*", "*"], None, "cli"), f"{TITLE}{DETAILS}Target: *\nTarget: *")

    def test_facts_with_resources_that_cannot_be_told_are_the_whole_details(self) -> None:
        message = card.build_message(TITLE, ["*"], described(("a", "b"), ("c", "d")), "cli")
        self.assertEqual(message, f"{TITLE}{DETAILS}a: b\nc: d")

    def test_targets_come_before_the_facts(self) -> None:
        message = card.build_message(TITLE, ["x", "y"], described(("a", "b")), "cli")
        self.assertEqual(message, f"{TITLE}{DETAILS}Target: x\nTarget: y\na: b")

    def test_a_text_alone_follows_the_title_under_its_own_label(self) -> None:
        message = card.build_message(TITLE, ["*"], described(text=("Note text", "hello\nworld")), "cli")
        self.assertEqual(message, f"{TITLE}\n\n--- Note text ---\n\nhello\nworld")

    def test_the_headline_stands_in_the_place_of_the_title(self) -> None:
        message = card.build_message(TITLE, ["a"], described(headline='Create the thing "x"'), "cli")
        self.assertEqual(message, f'Create the thing "x"{DETAILS}Target: a')

    def test_a_headline_that_would_push_a_target_past_the_cut_gives_way_to_the_title(self) -> None:
        headline = "H" * 490
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                message = card.build_message("Title", ["target/one"], described(headline=headline), surface)
                self.assertEqual(message, f"Title{DETAILS}Target: target/one")
        self.assertTrue(card.build_message("Title", ["target/one"], described(headline=headline), "cli").startswith("H"))

    def test_an_intent_as_the_stand_in_line_draws_the_card_without_a_description(self) -> None:
        message = card.build_message("About to create a thing", ["a"], None, "cli")
        self.assertEqual(message, f"About to create a thing{DETAILS}Target: a")

    def test_the_headline_wins_over_an_intent_and_gives_way_to_it_past_the_cut(self) -> None:
        intent = "About to create a thing"
        self.assertEqual(
            card.build_message(intent, ["a"], described(headline="Create the thing x"), "cli"),
            f"Create the thing x{DETAILS}Target: a",
        )
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                message = card.build_message(intent, ["target/one"], described(headline="H" * 490), surface)
                self.assertEqual(message, f"{intent}{DETAILS}Target: target/one")

    def test_a_long_headline_stays_when_the_title_would_not_fit_either(self) -> None:
        resources = [f"target/{n}" for n in range(40)]
        message = card.build_message("Title", resources, described(headline="Headline"), None)
        self.assertTrue(message.startswith("Headline\n"))

    def test_cli_and_tui_show_everything_in_full(self) -> None:
        facts = [(f"Label {n}", "v" * 200) for n in range(20)]
        resources = [f"target/{n}" for n in range(30)]
        body = "t" * 5000
        for surface in ("cli", "tui"):
            with self.subTest(surface=surface):
                expected = "\n".join(
                    [
                        TITLE,
                        "",
                        "--- Details ---",
                        "",
                        *(f"Target: {resource}" for resource in resources),
                        *(f"{label}: {value}" for label, value in facts),
                        "",
                        "--- Note ---",
                        "",
                        body,
                    ]
                )
                description = described(*facts, text=("Note", body))
                self.assertEqual(card.build_message(TITLE, resources, description, surface), expected)

    def test_marks_title_resources_labels_values_and_body(self) -> None:
        message = card.build_message(
            "a\u202eb",
            ["r\u200bs"],
            described(("la\tbel", "x\ny\r\nz"), text=("no\u2066te", "p\r\nq\rr\u200bs")),
            "cli",
        )
        self.assertEqual(
            message,
            "a<U+202E>b"
            f"{DETAILS}Target: r<U+200B>s\nla<U+0009>bel: x<U+000A>y<U+000D><U+000A>z"
            "\n\n--- no<U+2066>te ---\n\np\nq<U+000D>r<U+200B>s",
        )

    def test_marks_the_title_of_a_card_without_a_description_and_the_headline_of_one_with(self) -> None:
        self.assertEqual(card.build_message("a\u202eb", ["*"], None, "cli"), "a<U+202E>b")
        self.assertEqual(card.build_message("t", ["*"], described(headline="a\u202eb"), "cli"), "a<U+202E>b")

    def test_slack_escapes_mentions_links_and_ampersands_everywhere_but_the_frames(self) -> None:
        message = card.build_message(
            "H & <J>",
            ["<@U1>"],
            described(("Chat <!channel>", "<@U1> & <http://x|y>"), text=("<L>", "<!here>")),
            "slack",
        )
        self.assertEqual(
            message,
            "H &amp; &lt;J&gt;"
            f"{DETAILS}Target: &lt;@U1&gt;\nChat &lt;!channel&gt;: &lt;@U1&gt; &amp; &lt;http://x|y&gt;"
            "\n\n--- &lt;L&gt; ---\n\n&lt;!here&gt;",
        )

    def test_discord_escapes_everything_but_the_plugins_own_words(self) -> None:
        message = card.build_message(
            "A_B",
            ["x_y", "@everyone"],
            described(("Link", "[x](http://e)"), ("Who", "@everyone a_b"), text=("Note-1", "# t *b*")),
            "discord",
        )
        self.assertEqual(
            message,
            "A\\_B"
            f"{DETAILS}Target: x\\_y\nTarget: \\@everyone\nLink: \\[x\\]\\(http://e\\)\nWho: \\@everyone a\\_b"
            "\n\n--- Note\\-1 ---\n\n\\# t \\*b\\*",
        )
        self.assertEqual(card.build_message("A_B", ["x_y"], None, "discord"), f"A\\_B{DETAILS}Target: x\\_y")

    def test_an_unknown_or_missing_surface_gets_the_strictest_rules_and_budget(self) -> None:
        facts = [(f"Label {n}", "[v]" * 30) for n in range(20)]
        expected = card.build_message(TITLE, ["a_b"], described(*facts), "discord")
        for surface in (None, "desktop", "acp", 5):
            with self.subTest(surface=surface):
                message = card.build_message(TITLE, ["a_b"], described(*facts), surface)
                self.assertEqual(message, expected)
                self.assertLessEqual(len(message), 300)
                self.assertIn("\\[v\\]", message)
                self.assertIn("Target: a\\_b", message)

    def test_telegram_is_not_escaped(self) -> None:
        message = card.build_message("H", ["<b>&"], described(("a", "<b>&[x](y)@all")), "telegram")
        self.assertEqual(message, f"H{DETAILS}Target: <b>&\na: <b>&[x](y)@all")

    def test_the_budget_holds_for_many_targets_and_facts_and_both_keep_their_order(self) -> None:
        resources = [f"target/{n}" for n in range(3)]
        facts = [(f"Label {n}", "v" * 30) for n in range(40)]
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                target = card.surface_for(surface)
                message = card.build_message(TITLE, resources, described(*facts), surface)
                self.assertLessEqual(target.measure(message), target.budget)
                lines = message.split("\n")
                self.assertEqual(lines[:7], [TITLE, "", "--- Details ---", "", *(f"Target: {r}" for r in resources)])
                shown = lines[7:-1]
                self.assertEqual(shown, [f"{label}: {value}" for label, value in facts[: len(shown)]])
                self.assertEqual(lines[-1], f"(+{len(facts) - len(shown)} more)")

    def test_targets_are_never_cut_or_dropped_and_leave_no_room_for_facts(self) -> None:
        resources = [f"target/{n:02d}" for n in range(50)]
        head = "\n".join([TITLE, "", "--- Details ---", "", *(f"Target: {r}" for r in resources)])
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                message = card.build_message(TITLE, resources, described(("A", "a"), ("B", "b")), surface)
                self.assertEqual(message, head)

    def test_facts_that_all_fit_have_no_more_line(self) -> None:
        facts = [("a", "b"), ("c", "d")]
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                message = card.build_message("H", ["t"], described(*facts), surface)
                self.assertEqual(message, f"H{DETAILS}Target: t\na: b\nc: d")

    def test_a_long_value_is_cut_with_an_ellipsis_and_followed_by_the_count_of_the_rest(self) -> None:
        # The first line and the frame take 20 characters, "A: a\n" 5, "B: " 3, "…" 1 and "\n(+1 more)" 10.
        message = card.build_message("H", ["*"], described(("A", "a"), ("B", "b" * 1000), ("C", "c")), "slack")
        self.assertEqual(message, f"H{DETAILS}A: a\nB: " + "b" * 461 + "…\n(+1 more)")
        self.assertEqual(len(message), 500)

    def test_a_cut_last_fact_has_no_more_line(self) -> None:
        message = card.build_message("H", ["*"], described(("A", "a"), ("B", "b" * 1000)), "slack")
        self.assertEqual(message, f"H{DETAILS}A: a\nB: " + "b" * 471 + "…")
        self.assertEqual(len(message), 500)

    def test_a_fact_that_keeps_fewer_than_eight_code_points_is_dropped(self) -> None:
        # 20 characters, "A: " and 255 characters leave room for 7 characters of the next value.
        message = card.build_message("H", ["*"], described(("A", "a" * 255), ("B", "b" * 100), ("C", "c")), "discord")
        self.assertEqual(message, f"H{DETAILS}A: " + "a" * 255 + "\n(+2 more)")

    def test_a_fact_that_keeps_exactly_eight_code_points_is_cut(self) -> None:
        # 20 characters, "A: ", 254 characters, "\nB: " and "\n(+1 more)" leave room for 8 characters and the ellipsis.
        message = card.build_message("H", ["*"], described(("A", "a" * 254), ("B", "b" * 100), ("C", "c")), "discord")
        self.assertEqual(message, f"H{DETAILS}A: " + "a" * 254 + "\nB: " + "b" * 8 + "…\n(+1 more)")
        self.assertEqual(len(message), 300)

    def test_shown_facts_are_removed_from_the_end_until_the_more_line_fits(self) -> None:
        message = card.build_message("H", ["*"], described(("A", "a" * 275), ("B", "b" * 100)), "discord")
        self.assertEqual(message, f"H{DETAILS}(+2 more)")

    def test_a_head_over_the_budget_shows_no_fact_and_no_notice(self) -> None:
        title = "x" * 400
        message = card.build_message(title, ["t"], described(("A", "a"), ("B", "b"), text=("Note", "t")), "discord")
        self.assertEqual(message, f"{title}{DETAILS}Target: t\n\n--- Note ---\n\nt")
        message = card.build_message(title, ["t"], described(("A", "a")), "discord")
        self.assertEqual(message, f"{title}{DETAILS}Target: t")

    def test_facts_that_all_drop_leave_the_frame_with_the_notice_when_it_fits(self) -> None:
        title = "x" * 270
        message = card.build_message(title, ["*"], described(("A", "a" * 100), ("B", "b")), "discord")
        self.assertEqual(message, f"{title}{DETAILS}(+2 more)")
        self.assertEqual(len(message), 298)

    def test_facts_that_all_drop_leave_no_details_when_the_notice_does_not_fit_either(self) -> None:
        title = "x" * 299
        self.assertEqual(card.build_message(title, ["*"], described(("A", "b")), "discord"), title)
        self.assertEqual(
            card.build_message(title, ["*"], described(("A", "b"), text=("Note", "t")), "discord"),
            f"{title}\n\n--- Note ---\n\nt",
        )

    def test_a_head_that_leaves_no_room_for_the_notice_shows_no_fact(self) -> None:
        # The head is 20 characters and "Target: " 8, so the resource makes it 298: no room for a line or the notice.
        resource = "r" * 270
        message = card.build_message("H", [resource], described(("A", "b")), "discord")
        self.assertEqual(message, f"H{DETAILS}Target: {resource}")

    def test_the_text_follows_in_full_and_is_not_counted_against_the_budget(self) -> None:
        facts = [(f"Label {n}", "v" * 30) for n in range(40)]
        body = "line one\n" + "t" * 5000
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                without = card.build_message(TITLE, ["a"], described(*facts), surface)
                message = card.build_message(TITLE, ["a"], described(*facts, text=("Note", body)), surface)
                self.assertEqual(message, f"{without}\n\n--- Note ---\n\n{body}")
                self.assertEqual(self.head_of(message), without)

    def test_telegram_measures_after_the_html_escape(self) -> None:
        message = card.build_message("H", ["*"], described(("A", "&" * 600)), "telegram")
        # 20 units for the first line and the frame, "A: " 3, "…" one, and each "&" is the 5 units of "&amp;".
        self.assertEqual(message, f"H{DETAILS}A: " + "&" * 95 + "…")
        self.assertLessEqual(card.surface_for("telegram").measure(message), 500)
        self.assertGreater(card.surface_for("telegram").measure(message.replace("…", "&&…")), 500)

    def test_telegram_measures_in_utf16_units_and_never_splits_a_surrogate_pair(self) -> None:
        message = card.build_message("H", ["*"], described(("A", "😀" * 600)), "telegram")
        self.assertEqual(message, f"H{DETAILS}A: " + "😀" * 238 + "…")
        self.assertLessEqual(card.surface_for("telegram").measure(message), 500)
        message.encode("utf-16-le")

    def test_a_missing_surface_fits_entities_within_the_strictest_telegram_units(self) -> None:
        message = card.build_message("H", ["&"], described(("A", "&" * 200)), None)
        self.assertLessEqual(card.surface_for("telegram").measure(message), 300)
        self.assertTrue(message.endswith("…"))
        self.assertNotIn("&amp;" * 200, message)

    def test_a_lone_surrogate_is_marked_before_it_is_measured(self) -> None:
        description = described(("A\udc00", "\ud800" * 600), text=("Note", "\ud83d"))
        message = card.build_message("H\ud800", ["r\ud800"], description, "telegram")
        message.encode("utf-16-le")
        self.assertIn("<U+D800>", message)
        self.assertIn("<U+D83D>", message)
        self.assertLessEqual(card.surface_for("telegram").measure(self.head_of(message)), 500)

    def test_escapes_are_measured_and_never_split_by_a_cut(self) -> None:
        for surface, escaped in (("slack", "&lt;"), ("discord", "&lt;")):
            with self.subTest(surface=surface):
                target = card.surface_for(surface)
                message = card.build_message("H", ["*"], described(("A", "<" * 1000)), surface)
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
                message = card.build_message("H", ["*"], described(("A", value)), surface)
                self.assertEqual(message, self.longest_cut(target, value))

    def test_english_words_given_explicitly_change_nothing(self) -> None:
        facts = [(f"Label {n}", "v&[" * 30) for n in range(20)]
        description = described(*facts, text=("Note", "t"))
        for surface in (*ALL_SURFACES, "CLI", 5):
            with self.subTest(surface=surface):
                self.assertEqual(
                    card.build_message(TITLE, ["a_b"], description, surface, card.ENGLISH_WORDS),
                    card.build_message(TITLE, ["a_b"], description, surface),
                )

    def test_japanese_words_draw_the_cli_card(self) -> None:
        description = described(("サイズ", "1 byte"), text=("メモの本文", "x"))
        expected = "\n".join(
            [
                "メモを作成する",
                "",
                "--- 詳細 ---",
                "",
                "対象: /work/tree/notes/todo.md",
                "サイズ: 1 byte",
                "",
                "--- メモの本文 ---",
                "",
                "x",
            ]
        )
        for surface in ("cli", "tui"):
            with self.subTest(surface=surface):
                message = card.build_message(
                    "メモを作成する", ["/work/tree/notes/todo.md"], description, surface, JAPANESE
                )
                self.assertEqual(message, expected)

    def test_japanese_words_without_a_description_or_with_no_target_to_name(self) -> None:
        self.assertEqual(
            card.build_message("メモを作成する", ["a", "b"], None, "cli", JAPANESE),
            "メモを作成する\n\n--- 詳細 ---\n\n対象: a\n対象: b",
        )
        self.assertEqual(
            card.build_message("メモを作成する", ["*"], described(("サイズ", "1")), "cli", JAPANESE),
            "メモを作成する\n\n--- 詳細 ---\n\nサイズ: 1",
        )
        self.assertEqual(card.build_message("メモを作成する", ["*"], None, "cli", JAPANESE), "メモを作成する")

    def test_the_japanese_notice_counts_the_facts_not_shown_and_the_budget_holds(self) -> None:
        facts = [(f"ラベル {n}", "値" * 30) for n in range(40)]
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                target = card.surface_for(surface)
                message = card.build_message("メモ", ["a", "b"], described(*facts), surface, JAPANESE)
                self.assertLessEqual(target.measure(message), target.budget)
                lines = message.split("\n")
                self.assertEqual(lines[:6], ["メモ", "", "--- 詳細 ---", "", "対象: a", "対象: b"])
                shown = lines[6:-1]
                self.assertTrue(shown)
                self.assertEqual(shown, [f"{label}: {value}" for label, value in facts[: len(shown)]])
                self.assertEqual(lines[-1], f"（ほか {len(facts) - len(shown)} 件）")

    def test_the_words_used_are_the_ones_measured(self) -> None:
        # Each "&" is 5 UTF-16 units once Hermes has escaped it, so these words leave room for the notice only.
        facts = [(f"L{n}", "v" * 30) for n in range(10)]
        wide = card.Words(details="&" * 30, target="&" * 30, more="&" * 30 + " {count}")
        english = card.build_message("H", ["a"], described(*facts), "telegram")
        self.assertEqual(english.count("\nL"), 10)
        message = card.build_message("H", ["a"], described(*facts), "telegram", wide)
        self.assertEqual(message, f"H\n\n--- {'&' * 30} ---\n\n{'&' * 30}: a\n{'&' * 30} 10")
        self.assertLessEqual(card.surface_for("telegram").measure(message), 500)

    def test_a_translated_heading_that_over_fills_the_head_shows_no_fact(self) -> None:
        words = card.Words(details="詳" * 290, target="対象", more="（ほか {count} 件）")
        message = card.build_message("H", ["t"], described(("A", "a")), "discord", words)
        self.assertEqual(message, f"H\n\n--- {'詳' * 290} ---\n\n対象: t")

    def test_translated_words_are_escaped_for_the_surface_but_not_the_frames_or_the_colon(self) -> None:
        words = card.Words(details="詳_細", target="対*象", more="[ほか {count} 件]")
        facts = (("A", "a"), ("B", "b"))
        self.assertEqual(
            card.build_message("T", ["x_y"], described(*facts), "discord", words),
            "T\n\n--- 詳\\_細 ---\n\n対\\*象: x\\_y\nA: a\nB: b",
        )
        cut = card.build_message("T", ["*"], described(("A", "a"), ("B", "b" * 1000), ("C", "c")), "discord", words)
        self.assertTrue(cut.startswith("T\n\n--- 詳\\_細 ---\n\nA: a\nB: bbbb"))
        self.assertTrue(cut.endswith("…\n\\[ほか 1 件\\]"))
        self.assertLessEqual(card.STRICTEST_SURFACE.measure(cut), 300)
        angle = card.Words(details="<詳細>", target="<対象>", more="<ほか {count} 件>")
        slack = card.build_message("T", ["x"], described(("A", "a"), ("B", "b" * 1000), ("C", "c")), "slack", angle)
        self.assertTrue(slack.startswith("T\n\n--- &lt;詳細&gt; ---\n\n&lt;対象&gt;: x\nA: a\nB: bbbb"))
        self.assertTrue(slack.endswith("…\n&lt;ほか 1 件&gt;"))

    def test_translated_words_are_marked(self) -> None:
        words = card.Words(details="詳\u202e細", target="対\u200b象", more="ほか\u2066 {count}")
        message = card.build_message("T", ["x"], described(("A", "a"), ("B", "b" * 1000), ("C", "c")), "telegram", words)
        self.assertTrue(message.startswith("T\n\n--- 詳<U+202E>細 ---\n\n対<U+200B>象: x\nA: a\nB: bbbb"))
        self.assertTrue(message.endswith("…\nほか<U+2066> 1"))

    def longest_cut(self, target: object, value: str) -> str:
        """The card for one fact with the longest prefix of ``value`` that fits, found by trying each length."""
        fitting = [
            message
            for size in range(len(value))
            if target.measure(message := f"H{DETAILS}{target.escape(f'A: {value[:size]}…')}") <= target.budget
        ]
        return fitting[-1]


if __name__ == "__main__":
    unittest.main()
