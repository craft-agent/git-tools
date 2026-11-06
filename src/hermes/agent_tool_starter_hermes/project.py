"""The plugin's identity and constants that differ between tool packages."""

from __future__ import annotations

#: The plugin's name: used as a log prefix, approval rule key prefix and Hermes toolset prefix.
PLUGIN_NAME = "agent-tool-starter"

#: The built command-line name used in error and log messages.
CLI_NAME = "agent-tool-starter-cli"

#: The prefix skills start with: skills named ``<SKILL_PREFIX><topic>`` are registered without it.
SKILL_PREFIX = "example-"

#: The emoji each toolset is shown with; empty by default until a project adds its own.
TOOLSET_EMOJI: dict[str, str] = {}

__all__ = [
    "CLI_NAME",
    "PLUGIN_NAME",
    "SKILL_PREFIX",
    "TOOLSET_EMOJI",
]
