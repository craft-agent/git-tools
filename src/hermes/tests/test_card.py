"""Tests of the approval card's message: marking and parsing a description."""

from __future__ import annotations

import importlib
import unittest

from support import IMPL, ROOT_NAME

card = importlib.import_module(f"{ROOT_NAME}.{IMPL}.card")


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
    def test_reads_facts_and_text(self) -> None:
        parsed = card.parse_description(
            {"facts": [{"label": "Kind", "value": "group"}, {"label": "Size", "value": ""}], "text": "hi"}
        )
        self.assertEqual(parsed, card.Description(facts=(("Kind", "group"), ("Size", "")), text="hi"))

    def test_text_is_optional_and_facts_may_be_empty_beside_a_text(self) -> None:
        self.assertEqual(
            card.parse_description({"facts": [{"label": "a", "value": "b"}]}),
            card.Description(facts=(("a", "b"),), text=None),
        )
        self.assertEqual(
            card.parse_description({"facts": [{"label": "a", "value": "b"}], "text": ""}),
            card.Description(facts=(("a", "b"),), text=None),
        )
        self.assertEqual(card.parse_description({"facts": [], "text": "t"}), card.Description(facts=(), text="t"))

    def test_ignores_extra_keys(self) -> None:
        parsed = card.parse_description({"facts": [{"label": "a", "value": "b", "x": 1}], "y": 2})
        self.assertEqual(parsed, card.Description(facts=(("a", "b"),), text=None))

    def test_anything_else_is_none(self) -> None:
        bad = [
            None,
            [],
            "text",
            5,
            {},
            {"facts": "x"},
            {"facts": None},
            {"facts": []},
            {"facts": [], "text": ""},
            {"facts": [1]},
            {"facts": [{"label": "a", "value": "b"}, "x"]},
            {"facts": [{"label": " ", "value": "v"}]},
            {"facts": [{"label": "", "value": "v"}]},
            {"facts": [{"label": 1, "value": "v"}]},
            {"facts": [{"label": "a", "value": 1}]},
            {"facts": [{"label": "a"}]},
            {"facts": [{"value": "v"}]},
            {"facts": [{"label": "a", "value": "b"}], "text": 5},
            {"facts": [{"label": "a", "value": "b"}], "text": None},
        ]
        for raw in bad:
            with self.subTest(raw=raw):
                self.assertIsNone(card.parse_description(raw))


if __name__ == "__main__":
    unittest.main()
