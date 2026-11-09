"""The tools the command line offers for the current settings."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from . import project
from .runtime import CliError, Runtime, Unavailable

#: How long ``list`` may take, in seconds.
LIST_TIMEOUT_SECONDS = 30

#: The write class of a tool that changes nothing.
READ_CLASS = "read"

#: The fields of a listed tool that are text.
_TEXT_FIELDS = ("id", "title", "description", "toolset", "class")


@dataclass(frozen=True)
class ToolInfo:
    """One tool as ``list`` describes it; ``intent`` is its English approval line, ``None`` when it has none or a bad one."""

    id: str
    title: str
    description: str
    toolset: str
    write_class: str
    input_schema: dict[str, Any]
    intent: str | None = None

    @classmethod
    def from_listing(cls, entry: Any) -> ToolInfo:
        """Read one element of the ``list`` array.

        Raises:
            Unavailable: the element lacks a field the plugin needs.
        """
        if (
            not isinstance(entry, dict)
            or not all(isinstance(entry.get(field), str) for field in _TEXT_FIELDS)
            or not isinstance(entry.get("input_schema"), dict)
        ):
            raise Unavailable(f"{project.CLI_NAME} listed a tool the plugin cannot read: {entry!r}")
        intent = entry.get("intent")
        return cls(
            intent=intent if isinstance(intent, str) and intent.strip() else None,
            id=entry["id"],
            title=entry["title"],
            description=entry["description"],
            toolset=entry["toolset"],
            write_class=entry["class"],
            input_schema=entry["input_schema"],
        )


def list_tools(runtime: Runtime, flags: list[str]) -> list[ToolInfo]:
    """Ask the command line which tools the settings select.

    Raises:
        Unavailable: the command line failed or answered with something else than a tool list.
    """
    try:
        result = runtime.run(["list", *flags], timeout=LIST_TIMEOUT_SECONDS)
    except CliError as error:
        raise Unavailable(str(error)) from error
    if result.code != 0:
        detail = result.stderr.strip() or f"exit status {result.code}"
        raise Unavailable(f"`{project.CLI_NAME} list` failed: {detail}")
    try:
        listing = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise Unavailable(f"`{project.CLI_NAME} list` did not answer with JSON") from error
    if not isinstance(listing, list):
        raise Unavailable(f"`{project.CLI_NAME} list` did not answer with a list")
    return [ToolInfo.from_listing(entry) for entry in listing]
