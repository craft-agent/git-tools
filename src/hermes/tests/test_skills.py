"""Tests of registering the package's skills."""

from __future__ import annotations

import unittest
from pathlib import Path

from support import LISTING, ROOT, FakeCliCase, StubContext, plugin, project, skills


class SkillsTest(FakeCliCase):
    def skill(self, folder: str, text: str) -> Path:
        path = self.skills_dir / folder / "SKILL.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_registers_each_skill_without_the_skill_prefix(self) -> None:
        items = self.skill("items", f"---\nname: {project.SKILL_PREFIX}items\ndescription: Work with items\n---\n# Items\n")
        widgets = self.skill("widgets", f'---\nname: "{project.SKILL_PREFIX}widgets"\ndescription: \'It\'\'s a widget\'\n---\nBody')
        self.assertEqual(
            self.register().skills,
            [("items", items, "Work with items"), ("widgets", widgets, "It's a widget")],
        )

    def test_a_skill_without_a_name_takes_its_folder_name(self) -> None:
        path = self.skill("triage", "---\ndescription: Sort things # trailing comment\n---\nBody")
        self.assertEqual(self.register().skills, [("triage", path, "Sort things")])

    def test_a_skill_without_frontmatter_is_still_registered(self) -> None:
        path = self.skill("plain", "# Just text\n")
        self.assertEqual(self.register().skills, [("plain", path, "")])

    def test_only_plain_and_quoted_single_line_values_are_read(self) -> None:
        path = self.skill("folded", f"---\nname: >\n  {project.SKILL_PREFIX}folded\ndescription: [a, b]\n---\nBody")
        self.assertEqual(self.register().skills, [("folded", path, "")])

    def test_a_name_that_is_only_the_prefix_is_kept(self) -> None:
        path = self.skill("bare", f"---\nname: {project.SKILL_PREFIX}\n---\nBody")
        self.assertEqual(self.register().skills, [(project.SKILL_PREFIX, path, "")])

    def test_the_first_of_two_skills_with_one_name_wins(self) -> None:
        first = self.skill("a", f"---\nname: {project.SKILL_PREFIX}items\n---\nA")
        self.skill("b", f"---\nname: {project.SKILL_PREFIX}items\n---\nB")
        self.assertEqual([path for _, path, _ in self.register().skills], [first])

    def test_folders_without_a_skill_file_and_plain_files_are_skipped(self) -> None:
        (self.skills_dir / "empty").mkdir(parents=True)
        (self.skills_dir / "README.md").write_text("not a skill", encoding="utf-8")
        self.assertEqual(self.register().skills, [])

    def test_a_missing_folder_registers_nothing(self) -> None:
        ctx = self.register()
        self.assertEqual(ctx.skills, [])
        self.assertEqual(len(ctx.tools), len(LISTING))

    def test_a_skill_hermes_refuses_is_skipped_and_the_rest_register(self) -> None:
        self.skill("bad", f"---\nname: {project.SKILL_PREFIX}bad name\n---\nBody")
        good = self.skill("good", f"---\nname: {project.SKILL_PREFIX}good\n---\nBody")

        class Refusing(StubContext):
            def register_skill(self, name: str, path: Path, description: str = "") -> None:
                if " " in name:
                    raise ValueError(f"Invalid skill name '{name}'")
                super().register_skill(name, path, description)

        self.write_fixture()
        ctx = Refusing()
        with self.assertLogs(skills.logger, "WARNING") as logs:
            plugin.register(ctx)
        self.assertEqual(ctx.skills, [("good", good, "")])
        self.assertEqual(len(logs.records), 1)
        self.assertEqual(len(ctx.tools), len(LISTING))

    def test_the_repositorys_own_skills_register_under_valid_names(self) -> None:
        ctx = StubContext()
        skills.register_skills(ctx, ROOT / "skills")
        for name, path, _ in ctx.skills:
            self.assertRegex(name, r"^[a-zA-Z0-9_-]+$")
            self.assertTrue(path.is_file())


if __name__ == "__main__":
    unittest.main()
