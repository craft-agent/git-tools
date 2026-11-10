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

#: The settings the tools themselves read, beside the ones every plugin takes: each holds text and is named in
#: snake_case, as in ``src/project.ts``. A setting ``a_b`` becomes the flag ``--a-b`` of the command line.
OPTIONS: tuple[str, ...] = ("published_text_rules",)

__all__ = [
    "CLI_NAME",
    "OPTIONS",
    "PLUGIN_NAME",
    "SKILL_PREFIX",
    "TOOLSET_EMOJI",
]
