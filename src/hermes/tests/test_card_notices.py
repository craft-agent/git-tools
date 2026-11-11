"""Tests of the approval card's notice of the characters the tool's cut left out of a fact's value and of the text."""

from __future__ import annotations

import importlib
import unittest

from support import IMPL, JAPANESE, ROOT_NAME, described

card = importlib.import_module(f"{ROOT_NAME}.{IMPL}.card")

TITLE = "Create a thing"
BUDGETED = ("telegram", "slack", "discord", None)
UNBUDGETED = ("cli", "tui", "desktop", "acp", "whatsapp", "unheard-of")
DETAILS = "\n\n--- Details ---\n\n"

#: The first line "H" and the Details frame take 20 characters, and "A: " 3.
DISCORD_ROOM = 300 - 20 - len("A: ")


def english_notice(count: int) -> str:
    return f"(+{count} more character)" if count == 1 else f"(+{count} more characters)"


def with_words(**changes: str) -> object:
    return card.Words(**{**card.ENGLISH_WORDS.__dict__, **changes})


class CutTextTest(unittest.TestCase):
    def test_a_cut_text_is_followed_by_the_notice_line(self) -> None:
        for surface in ("cli", "tui"):
            with self.subTest(surface=surface):
                message = card.build_message(
                    TITLE, ["*"], described(text=("Note", "hello\nworld…"), text_omitted=1234), surface
                )
                self.assertEqual(message, f"{TITLE}\n\n--- Note ---\n\nhello\nworld…\n(+1234 more characters)")

    def test_one_character_is_singular(self) -> None:
        message = card.build_message(TITLE, ["*"], described(text=("Note", "t…"), text_omitted=1), "cli")
        self.assertEqual(message, f"{TITLE}\n\n--- Note ---\n\nt…\n(+1 more character)")

    def test_a_text_that_was_not_cut_has_no_notice(self) -> None:
        message = card.build_message(TITLE, ["*"], described(text=("Note", "t")), "cli")
        self.assertEqual(message, f"{TITLE}\n\n--- Note ---\n\nt")

    def test_the_notice_is_the_last_line_after_the_facts(self) -> None:
        message = card.build_message(
            TITLE, ["a"], described(("k", "v"), text=("Note", "t…"), text_omitted=3), "cli"
        )
        self.assertEqual(message, f"{TITLE}{DETAILS}Target: a\nk: v\n\n--- Note ---\n\nt…\n(+3 more characters)")

    def test_japanese_words_make_the_notice(self) -> None:
        description = described(text=("本文", "あ…"), text_omitted=7)
        message = card.build_message("メモ", ["*"], description, "cli", JAPANESE)
        self.assertEqual(message, "メモ\n\n--- 本文 ---\n\nあ…\n（ほか 7 文字）")

    def test_the_form_is_picked_by_the_count(self) -> None:
        words = with_words(more_character="one {count}", more_characters="many {count}")
        for count, expected in ((1, "one 1"), (2, "many 2"), (100, "many 100")):
            with self.subTest(count=count):
                message = card.build_message(
                    TITLE, ["*"], described(text=("Note", "t…"), text_omitted=count), "cli", words
                )
                self.assertTrue(message.endswith(f"\n{expected}"))

    def test_the_text_and_its_notice_are_not_counted_against_the_budget(self) -> None:
        facts = [(f"Label {n}", "v" * 30) for n in range(40)]
        body = "t" * 5000 + "…"
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                without = card.build_message(TITLE, ["a"], described(*facts), surface)
                message = card.build_message(
                    TITLE, ["a"], described(*facts, text=("Note", body), text_omitted=99), surface
                )
                self.assertEqual(message, f"{without}\n\n--- Note ---\n\n{body}\n(+99 more characters)")

    def test_translated_notice_is_escaped_for_the_surface(self) -> None:
        words = with_words(more_character="*ほか* <{count}>_", more_characters="*ほか* <{count}>_")
        description = described(text=("Note", "t…"), text_omitted=5)
        cases = {
            "discord": "\\*ほか\\* \\<5\\>\\_",
            "slack": "*ほか* &lt;5&gt;_",
            "telegram": "*ほか* <5>_",
            "cli": "*ほか* <5>_",
            "matrix": "\\*ほか\\* &lt;5&gt;\\_",
            None: "\\*ほか\\* &lt;5&gt;\\_",
        }
        for surface, expected in cases.items():
            with self.subTest(surface=surface):
                message = card.build_message(TITLE, ["*"], description, surface, words)
                self.assertTrue(message.endswith(f"\nt…\n{expected}"), message)

    def test_translated_notice_is_marked(self) -> None:
        words = with_words(more_character="ほか\u2066 {count}", more_characters="ほか\u2066 {count}")
        message = card.build_message(TITLE, ["*"], described(text=("Note", "t…"), text_omitted=2), "cli", words)
        self.assertTrue(message.endswith("\nt…\nほか<U+2066> 2"))

    def test_the_english_notice_is_the_plugins_own_word_and_stays_as_written(self) -> None:
        message = card.build_message(TITLE, ["*"], described(text=("Note", "t…"), text_omitted=2), "discord")
        self.assertTrue(message.endswith("\nt…\n(+2 more characters)"))


class CutValueWithoutBudgetTest(unittest.TestCase):
    def test_the_notice_follows_the_value_after_a_space(self) -> None:
        value = "v" * 200 + "…"
        for surface in ("cli", "tui", "desktop", "acp"):
            with self.subTest(surface=surface):
                description = described(("Body", value), ("Next", "n"), omitted=(75, 0))
                message = card.build_message(TITLE, ["a"], description, surface)
                self.assertEqual(message, f"{TITLE}{DETAILS}Target: a\nBody: {value} (+75 more characters)\nNext: n")

    def test_one_character_is_singular(self) -> None:
        message = card.build_message(TITLE, ["*"], described(("Body", "v…"), omitted=(1,)), "cli")
        self.assertEqual(message, f"{TITLE}{DETAILS}Body: v… (+1 more character)")

    def test_a_surface_hermes_does_not_cut_always_gets_the_notice_however_long_the_line(self) -> None:
        facts = [(f"Label {n}", "v" * 200 + "…") for n in range(30)]
        for surface in UNBUDGETED:
            with self.subTest(surface=surface):
                message = card.build_message(TITLE, ["*"], described(*facts, omitted=(5,) * 30), surface)
                self.assertEqual(message.count(" (+5 more characters)"), 30)
                self.assertNotIn("(+", message.replace("(+5 more characters)", ""))

    def test_japanese_words(self) -> None:
        description = described(("サイズ", "1 byte…"), omitted=(1,))
        message = card.build_message("メモ", ["*"], description, "cli", JAPANESE)
        self.assertEqual(message, "メモ\n\n--- 詳細 ---\n\nサイズ: 1 byte… （ほか 1 文字）")

    def test_a_fact_that_was_not_cut_gets_no_notice_whatever_its_neighbours(self) -> None:
        message = card.build_message(
            TITLE, ["*"], described(("A", "a"), ("B", "b…"), ("C", "c"), omitted=(0, 4, 0)), "cli"
        )
        self.assertEqual(message, f"{TITLE}{DETAILS}A: a\nB: b… (+4 more characters)\nC: c")

    def test_an_unknown_surface_escapes_the_value_and_the_translated_notice(self) -> None:
        words = with_words(more_character="*{count}*", more_characters="*{count}*")
        message = card.build_message(TITLE, ["*"], described(("A", "[v]…"), omitted=(3,)), "matrix", words)
        self.assertEqual(message, f"{TITLE}{DETAILS}A: \\[v\\]… \\*3\\*")


class CutValueWithBudgetTest(unittest.TestCase):
    def line(self, surface: str, value: str, count: int) -> str:
        return card.build_message("H", ["*"], described(("A", value), omitted=(count,)), surface)

    def test_a_line_that_fits_with_its_notice_gets_it_on_every_surface(self) -> None:
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                message = self.line(surface, "a" * 99 + "…", 120)
                self.assertEqual(message, f"H{DETAILS}A: " + "a" * 99 + "… (+120 more characters)")

    def test_the_notice_is_kept_when_the_line_fills_the_budget_exactly(self) -> None:
        notice = f" {english_notice(7)}"
        room = DISCORD_ROOM - len(notice)
        message = self.line("discord", "a" * (room - 1) + "…", 7)
        self.assertEqual(message, f"H{DETAILS}A: " + "a" * (room - 1) + "…" + notice)
        self.assertEqual(len(message), 300)

    def test_a_line_one_character_too_long_for_its_notice_is_shown_as_today_without_it(self) -> None:
        notice = f" {english_notice(7)}"
        value = "a" * (DISCORD_ROOM - len(notice)) + "…"
        message = self.line("discord", value, 7)
        self.assertEqual(message, f"H{DETAILS}A: {value}")
        self.assertEqual(message, self.line("discord", value, 0))

    def test_a_value_the_budget_cuts_further_ends_in_the_ellipsis_alone(self) -> None:
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                value = "a" * 1000 + "…"
                message = self.line(surface, value, 4321)
                self.assertEqual(message, self.line(surface, value, 0))
                self.assertTrue(message.endswith("…"))
                self.assertNotIn("(+", message)

    def test_a_cut_further_value_is_cut_as_today_among_other_facts(self) -> None:
        facts = (("A", "a"), ("B", "b" * 1000 + "…"), ("C", "c"))
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                message = card.build_message("H", ["*"], described(*facts, omitted=(0, 50, 0)), surface)
                self.assertEqual(message, card.build_message("H", ["*"], described(*facts), surface))
                self.assertNotIn("more characters", message)

    def test_a_notice_that_does_not_fit_is_left_out_before_its_fact_is_dropped(self) -> None:
        # "A: " and 256 characters with the notice fill the 300, so the "(+1 more)" line of the dropped fact B
        # leaves no room for it.
        value = "a" * 255 + "…"
        facts = (("A", value), ("B", "b" * 100))
        message = card.build_message("H", ["*"], described(*facts, omitted=(7, 0)), "discord")
        self.assertEqual(message, f"H{DETAILS}A: {value}\n(+1 more)")

    def test_a_notice_that_fits_with_the_facts_after_it_is_kept(self) -> None:
        facts = (("A", "a" * 99 + "…"), ("B", "b" * 1000))
        message = card.build_message("H", ["*"], described(*facts, omitted=(7, 0)), "discord")
        self.assertTrue(message.startswith(f"H{DETAILS}A: " + "a" * 99 + "… (+7 more characters)\nB: bbbb"))
        self.assertTrue(message.endswith("…"))
        self.assertLessEqual(len(message), 300)

    def test_the_budget_holds_across_surfaces_and_lengths_with_and_without_notices(self) -> None:
        for surface in BUDGETED:
            target = card.surface_for(surface)
            for size in range(0, 700, 11):
                for count in (0, 1, 22, 123456):
                    for words in (card.ENGLISH_WORDS, JAPANESE):
                        facts = (("A", "a" * size + "…"), ("B", "&<[" * 40), ("C", "c…"))
                        description = described(*facts, omitted=(count, 0, count))
                        message = card.build_message("H", ["t"], description, surface, words)
                        with self.subTest(surface=surface, size=size, count=count):
                            self.assertLessEqual(target.measure(message), target.budget)

    def test_a_notice_never_follows_a_value_cut_by_the_budget(self) -> None:
        for surface in BUDGETED:
            target = card.surface_for(surface)
            for size in range(100, 700, 13):
                value = "a" * size + "…"
                message = card.build_message("H", ["*"], described(("A", value), omitted=(9,)), surface)
                with self.subTest(surface=surface, size=size):
                    plain = card.build_message("H", ["*"], described(("A", value)), surface)
                    if message != plain:
                        self.assertEqual(message, f"{plain} (+9 more characters)")
                        self.assertLessEqual(target.measure(message), target.budget)

    def test_telegram_counts_the_notice_after_the_html_escape(self) -> None:
        # Each "&" is 5 UTF-16 units; 20 for the head, "A: " 3, the notice with its space 21 and the value 5 per "&".
        value = "&" * 91 + "…"
        message = self.line("telegram", value, 3)
        self.assertEqual(message, f"H{DETAILS}A: {value} (+3 more characters)")
        self.assertEqual(card.surface_for("telegram").measure(message), 20 + 3 + 91 * 5 + 1 + 21)
        # One "&" more is 505 with the notice and so is shown without it: 484 fits.
        too_long = "&" * 92 + "…"
        self.assertEqual(self.line("telegram", too_long, 3), f"H{DETAILS}A: {too_long}")

    def test_translated_notices_are_escaped_and_measured_as_shown(self) -> None:
        words = with_words(more_character="*ほか* <{count}>", more_characters="*ほか* <{count}>")
        value = "a" * 20 + "…"
        cases = {
            "discord": "\\*ほか\\* \\<3\\>",
            "slack": "*ほか* &lt;3&gt;",
            "telegram": "*ほか* <3>",
        }
        for surface, shown in cases.items():
            with self.subTest(surface=surface):
                message = card.build_message("H", ["*"], described(("A", value), omitted=(3,)), surface, words)
                self.assertEqual(message, f"H{DETAILS}A: {value} {shown}")

    def test_a_translated_notice_that_is_longer_once_escaped_is_left_out_when_it_does_not_fit(self) -> None:
        words = with_words(more_character="*{count}*", more_characters="*{count}*")
        # Escaped for Discord the notice is "\*3\*": 5 characters and a space, against 3 and a space unescaped.
        value = "a" * (DISCORD_ROOM - 6 + 1) + "…"
        escaped = card.build_message("H", ["*"], described(("A", value), omitted=(3,)), "discord", words)
        self.assertEqual(escaped, f"H{DETAILS}A: {value}")
        slack = card.build_message("H", ["*"], described(("A", value), omitted=(3,)), "slack", words)
        self.assertEqual(slack, f"H{DETAILS}A: {value} *3*")

    def test_the_english_notice_is_the_plugins_own_word_and_stays_as_written_on_discord(self) -> None:
        message = self.line("discord", "a…", 2)
        self.assertEqual(message, f"H{DETAILS}A: a… (+2 more characters)")

    def test_the_value_and_label_are_escaped_before_the_notice_is_added(self) -> None:
        message = card.build_message("H", ["*"], described(("A-b", "[x]…"), omitted=(2,)), "discord")
        self.assertEqual(message, f"H{DETAILS}A\\-b: \\[x\\]… (+2 more characters)")

    def test_the_notice_of_the_text_does_not_change_the_head(self) -> None:
        facts = (("A", "a" * 99 + "…"),)
        for surface in BUDGETED:
            with self.subTest(surface=surface):
                without = card.build_message("H", ["*"], described(*facts, omitted=(5,)), surface)
                message = card.build_message(
                    "H", ["*"], described(*facts, omitted=(5,), text=("Note", "t…"), text_omitted=8), surface
                )
                self.assertEqual(message, f"{without}\n\n--- Note ---\n\nt…\n(+8 more characters)")


if __name__ == "__main__":
    unittest.main()
