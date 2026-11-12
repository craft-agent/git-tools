"""The plugin's identity and constants that differ between tool packages."""

from __future__ import annotations

#: The plugin's name: used as a log prefix, approval rule key prefix and Hermes toolset prefix.
PLUGIN_NAME = "git-tools"

#: The built command-line name used in error and log messages.
CLI_NAME = "git-tools-cli"

#: The prefix skills start with: skills named ``<SKILL_PREFIX><topic>`` are registered without it.
SKILL_PREFIX = "git-"

#: The emoji each toolset is shown with; empty by default until a project adds its own.
TOOLSET_EMOJI: dict[str, str] = {}

#: The settings the tools themselves read: each snake_case name and a type (``text``, ``boolean``, ``number``,
#: ``list``, ``path`` or ``paths``) or a dict with ``type`` and optional bounds (``integer``, ``min``, ``max``),
#: as in ``src/project.ts``. Write OPTIONS on one line with double quotes. A setting ``a_b`` becomes ``--a-b``.
OPTIONS: dict[str, str | dict[str, object]] = {"published_text_rules": "text", "worktree_root": "text"}

__all__ = [
    "CLI_NAME",
    "OPTIONS",
    "PLUGIN_NAME",
    "SKILL_PREFIX",
    "TOOLSET_EMOJI",
]
