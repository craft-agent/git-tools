"""Tests of the link between a skill and a toolset: ``metadata.toolset`` and the skills it keeps out."""

from __future__ import annotations

import unittest
from pathlib import Path

from support import FakeCliCase, StubContext, project, skills


def front(*lines: str, eol: str = "\n") -> str:
    return eol.join(["---", *lines, "---", "Body"])


class ReadLinkTest(unittest.TestCase):
    def link(self, *lines: str, eol: str = "\n") -> str | None:
        return skills.read_frontmatter(front(*lines, eol=eol)).get("toolset")

    def test_a_plain_value_is_the_link(self) -> None:
        self.assertEqual(self.link("name: a", "metadata:", "  toolset: notes"), "notes")

    def test_quoted_values_and_comments_are_read(self) -> None:
        self.assertEqual(self.link("metadata: # block", '  toolset: "notes"  # c'), "notes")
        self.assertEqual(self.link("metadata:", "\ttoolset: 'notes'"), "notes")

    def test_crlf_reads_like_lf(self) -> None:
        self.assertEqual(self.link("name: a", "metadata:", "  toolset: notes", eol="\r\n"), "notes")

    def test_comments_and_blank_lines_do_not_end_the_block(self) -> None:
        self.assertEqual(self.link("metadata:", "", "  # note", "   ", "  toolset: notes"), "notes")

    def test_the_last_valid_link_wins(self) -> None:
        self.assertEqual(self.link("metadata:", "  toolset: a", "  toolset: b", "  toolset: [c]"), "b")

    def test_a_following_top_level_key_ends_the_block_and_is_read(self) -> None:
        found = skills.read_frontmatter(front("metadata:", "  toolset: notes", "description: Hello", "  toolset: other"))
        self.assertEqual(found, {"toolset": "notes", "description": "Hello"})

    def test_indented_name_and_description_are_not_top_level_ones(self) -> None:
        found = skills.read_frontmatter(front("metadata:", "  name: x", "  description: y", "  toolset: notes"))
        self.assertEqual(found, {"toolset": "notes"})

    def test_only_keys_at_the_first_indentation_count(self) -> None:
        self.assertIsNone(self.link("metadata:", "  nested:", "    toolset: notes"))
        self.assertIsNone(self.link("metadata:", "  other: 1", "    toolset: notes"))
        self.assertIsNone(self.link("metadata:", "    deep: 1", "  toolset: notes"))

    def test_other_forms_give_no_link(self) -> None:
        self.assertIsNone(self.link("metadata: {toolset: notes}"))
        self.assertIsNone(self.link("toolset: notes"))
        self.assertIsNone(self.link("metadata:", "  toolset: [notes]"))
        self.assertIsNone(self.link("metadata:", "  toolset:"))
        self.assertIsNone(self.link("other:", "  toolset: notes"))


class LinkedSkillsTest(FakeCliCase):
    def skill(self, folder: str, toolset: str | None = None, name: str | None = None) -> Path:
        lines = ["---", f"name: {project.SKILL_PREFIX}{name or folder}"]
        if toolset is not None:
            lines += ["metadata:", f"  toolset: {toolset}"]
        path = self.skills_dir / folder / "SKILL.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join([*lines, "---", "Body"]), encoding="utf-8")
        return path

    def names(self, ctx: StubContext) -> list[str]:
        return [name for name, _, _ in ctx.skills]

    def test_a_skill_follows_the_toolsets_of_the_listed_tools(self) -> None:
        self.skill("linked", "things")
        self.skill("missing", "no-such-toolset")
        self.skill("free")
        self.assertEqual(self.names(self.register()), ["free", "linked"])

    def test_a_toolset_no_selected_tool_has_leaves_its_skill_out(self) -> None:
        self.replies["list"] = {"stdout": "[]"}
        self.skill("linked", "things")
        self.skill("free")
        self.assertEqual(self.names(self.register()), ["free"])

    def test_a_left_out_skill_still_claims_its_name(self) -> None:
        self.skill("a", "no-such-toolset", name="same")
        self.skill("b", None, name="same")
        self.assertEqual(self.names(self.register()), [])

    def test_without_toolsets_every_skill_registers(self) -> None:
        self.skill("linked", "no-such-toolset")
        self.skill("free")
        ctx = StubContext()
        skills.register_skills(ctx, self.skills_dir)
        self.assertEqual(self.names(ctx), ["free", "linked"])


if __name__ == "__main__":
    unittest.main()
