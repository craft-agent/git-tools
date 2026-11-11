"""Tests of reading the characters a cut left out, and the words of their notice, from the command line."""

from __future__ import annotations

import importlib
import unittest

from support import IMPL, JAPANESE, ROOT_NAME, described

card = importlib.import_module(f"{ROOT_NAME}.{IMPL}.card")


class ParseOmittedTest(unittest.TestCase):
    def test_reads_the_count_of_a_fact_and_of_the_text(self) -> None:
        parsed = card.parse_description(
            {
                "facts": [
                    {"label": "a", "value": "b…", "omitted": 12},
                    {"label": "c", "value": "d"},
                    {"label": "e", "value": "f…", "omitted": 1},
                ],
                "text": {"label": "L", "body": "t…", "omitted": 345},
            }
        )
        self.assertEqual(
            parsed,
            described(
                ("a", "b…"), ("c", "d"), ("e", "f…"), omitted=(12, 0, 1), text=("L", "t…"), text_omitted=345
            ),
        )

    def test_a_description_that_was_not_cut_has_no_counts(self) -> None:
        parsed = card.parse_description({"facts": [{"label": "a", "value": "b"}], "text": {"label": "L", "body": "t"}})
        self.assertEqual(parsed.fact_omitted, ())
        self.assertEqual(parsed.text_omitted, 0)
        self.assertEqual(parsed, described(("a", "b"), text=("L", "t")))

    def test_anything_but_a_positive_integer_reads_as_none_and_is_never_an_error(self) -> None:
        for omitted in (0, -1, 1.5, 2.0, "3", "", None, True, False, [], {"n": 1}):
            with self.subTest(omitted=omitted):
                parsed = card.parse_description(
                    {
                        "facts": [{"label": "a", "value": "b", "omitted": omitted}],
                        "text": {"label": "L", "body": "t", "omitted": omitted},
                    }
                )
                self.assertEqual(parsed, described(("a", "b"), text=("L", "t")))

    def test_an_emptied_text_drops_its_count(self) -> None:
        parsed = card.parse_description(
            {"facts": [{"label": "a", "value": "b"}], "text": {"label": "L", "body": "", "omitted": 5}}
        )
        self.assertEqual(parsed, described(("a", "b")))


class ParseNoticeWordsTest(unittest.TestCase):
    GOOD = {
        "details": "詳細",
        "target": "対象",
        "more": "（ほか {count} 件）",
        "more_character": "（ほか {count} 文字）",
        "more_characters": "（ほか {count} 文字）",
    }

    def test_reads_the_five_words(self) -> None:
        self.assertEqual(card.parse_words(self.GOOD), JAPANESE)

    def test_the_words_of_the_notices_can_differ_by_form(self) -> None:
        words = card.parse_words(
            {**self.GOOD, "more_character": "{count} character", "more_characters": "{count} chars"}
        )
        self.assertEqual(words.more_character, "{count} character")
        self.assertEqual(words.more_characters, "{count} chars")

    def test_a_missing_or_bad_new_word_gives_all_english(self) -> None:
        for name in ("more_character", "more_characters"):
            bad = [
                {k: v for k, v in self.GOOD.items() if k != name},
                {**self.GOOD, name: ""},
                {**self.GOOD, name: "  "},
                {**self.GOOD, name: None},
                {**self.GOOD, name: ["{count}"]},
                {**self.GOOD, name: "ほか 文字"},
                {**self.GOOD, name: "{count} と {count}"},
                {**self.GOOD, name: "{count} {name}"},
                {**self.GOOD, name: "{count} {"},
                {**self.GOOD, name: "{count} }"},
                {**self.GOOD, name: "{{count}}"},
                {**self.GOOD, name: "{ count }"},
            ]
            for raw in bad:
                with self.subTest(name=name, raw=raw):
                    self.assertIs(card.parse_words(raw), card.ENGLISH_WORDS)

    def test_the_english_notices_are_the_constants(self) -> None:
        self.assertEqual(card.ENGLISH_WORDS.more_character, "(+{count} more character)")
        self.assertEqual(card.ENGLISH_WORDS.more_characters, "(+{count} more characters)")


if __name__ == "__main__":
    unittest.main()
