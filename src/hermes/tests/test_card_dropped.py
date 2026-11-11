"""Tests of the approval card's count of the facts the tool's description dropped past the eighth."""

from __future__ import annotations

import dataclasses
import importlib
import unittest

from support import IMPL, JAPANESE, ROOT_NAME, described

card = importlib.import_module(f"{ROOT_NAME}.{IMPL}.card")

TITLE = "Create a thing"
DETAILS = "\n\n--- Details ---\n\n"
EIGHT = tuple((f"f{index}", "v") for index in range(1, 9))


def dropping(count: int, *facts: tuple[str, str], **fields: object) -> object:
    return dataclasses.replace(described(*facts, **fields), dropped=count)


def fact_lines(facts: tuple[tuple[str, str], ...]) -> str:
    return "\n".join(f"{label}: {value}" for label, value in facts)


class ParseDroppedTest(unittest.TestCase):
    def test_reads_the_count_of_the_dropped_facts(self) -> None:
        parsed = card.parse_description({"facts": [{"label": "a", "value": "b"}], "dropped": 3})
        self.assertEqual(parsed, dropping(3, ("a", "b")))

    def test_anything_but_a_positive_integer_reads_as_none(self) -> None:
        for dropped in (0, -1, 1.5, "3", None, True, [2]):
            with self.subTest(dropped=dropped):
                parsed = card.parse_description({"facts": [{"label": "a", "value": "b"}], "dropped": dropped})
                self.assertEqual(parsed, described(("a", "b")))

    def test_a_count_without_facts_reads_as_none(self) -> None:
        parsed = card.parse_description({"headline": "H", "facts": [], "dropped": 2})
        self.assertEqual(parsed.dropped, 0)


class DroppedNoticeTest(unittest.TestCase):
    def test_every_fact_shown_is_followed_by_the_notice_of_the_dropped(self) -> None:
        for surface in ("cli", "tui", "unheard-of", "telegram", "slack", "discord"):
            with self.subTest(surface=surface):
                message = card.build_message(TITLE, ["*"], dropping(2, *EIGHT), surface)
                self.assertEqual(message, f"{TITLE}{DETAILS}{fact_lines(EIGHT)}\n(+2 more)")

    def test_the_notice_comes_after_the_targets_and_before_the_text(self) -> None:
        description = dropping(1, ("a", "b"), text=("Note", "t"))
        message = card.build_message(TITLE, ["x"], description, "cli")
        self.assertEqual(message, f"{TITLE}{DETAILS}Target: x\na: b\n(+1 more)\n\n--- Note ---\n\nt")

    def test_without_dropped_facts_there_is_no_notice(self) -> None:
        message = card.build_message(TITLE, ["*"], described(*EIGHT), "cli")
        self.assertEqual(message, f"{TITLE}{DETAILS}{fact_lines(EIGHT)}")

    def test_the_budget_adds_the_facts_it_leaves_out_to_the_dropped(self) -> None:
        long = tuple((f"f{index}", "v" * 60) for index in range(1, 9))
        message = card.build_message(TITLE, ["*"], dropping(5, *long), "discord")
        self.assertLessEqual(len(message), 300)
        shown = [line for line in message.split("\n") if line.startswith("f")]
        self.assertLess(len(shown), 8)
        self.assertTrue(message.endswith(f"(+{8 - len(shown) + 5} more)"))

    def test_a_fact_that_leaves_no_room_for_the_notice_is_cut(self) -> None:
        # Two facts that fill Discord's 300 characters to the brim leave no room for the notice line.
        first = "a" * (300 - len(f"{TITLE}{DETAILS}") - len("k: ") - len("\nj: b"))
        self.assertEqual(
            card.build_message(TITLE, ["*"], described(("k", first), ("j", "b")), "discord"),
            f"{TITLE}{DETAILS}k: {first}\nj: b",
        )
        message = card.build_message(TITLE, ["*"], dropping(1, ("k", first), ("j", "b")), "discord")
        self.assertLessEqual(len(message), 300)
        lines = message.split("\n")
        self.assertEqual(lines[-1], "(+2 more)")
        self.assertRegex(lines[-2], r"^k: a+…$")

    def test_each_fact_leaves_room_for_the_notice(self) -> None:
        facts = tuple((f"f{index}", "v" * 30) for index in range(1, 9))
        for surface in ("telegram", "slack", "discord"):
            with self.subTest(surface=surface):
                message = card.build_message(TITLE, ["*"], dropping(9, *facts), surface)
                self.assertLessEqual(card.surface_for(surface).measure(message), card.surface_for(surface).budget)
                self.assertRegex(message, r"\n\(\+\d+ more\)$")

    def test_a_head_over_the_budget_still_counts_every_fact(self) -> None:
        message = card.build_message("H" * 400, ["*"], dropping(4, *EIGHT), "discord")
        self.assertTrue(message.endswith("\n(+12 more)"))

    def test_japanese_words_make_the_notice(self) -> None:
        message = card.build_message("メモ", ["*"], dropping(3, ("サイズ", "1 バイト")), "cli", JAPANESE)
        self.assertEqual(message, "メモ\n\n--- 詳細 ---\n\nサイズ: 1 バイト\n（ほか 3 件）")


if __name__ == "__main__":
    unittest.main()
