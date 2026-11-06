"""Registering the package's skills, which sit in ``skills/<skill>/SKILL.md``."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from .context import PluginContext
from . import project

logger = logging.getLogger(__name__)

SKILL_FILE = "SKILL.md"

#: Skills are named ``<SKILL_PREFIX><topic>``; Hermes already shows the plugin's name before the skill's.
NAME_PREFIX = project.SKILL_PREFIX

_FRONTMATTER = re.compile(r"\A---[ \t]*\r?\n((?:.*?\r?\n)?)---[ \t]*(?:\r?\n|\Z)", re.DOTALL)
_KEY_LINE = re.compile(r"^(name|description)[ \t]*:[ \t]*(.*?)[ \t]*$")
#: Where a YAML value stops being a plain one-line scalar this reader understands.
_UNSUPPORTED_VALUE_START = re.compile(r"^[>|\[{&*!%@`]")
_TRAILING_COMMENT = re.compile(r"[ \t]+#.*$")
#: A quoted scalar with nothing after its closing quote but an optional comment.
_SINGLE_QUOTED = re.compile(r"^'((?:[^']|'')*)'(?:[ \t]+#.*)?$")
_DOUBLE_QUOTED = re.compile(r'^"((?:[^"\\]|\\.)*)"(?:[ \t]+#.*)?$')


def _unquote(value: str) -> str | None:
    """The text of a quoted scalar, or ``None`` when it is not a well-formed one."""
    single = _SINGLE_QUOTED.match(value)
    if single:
        return single.group(1).replace("''", "'")
    double = _DOUBLE_QUOTED.match(value)
    if not double:
        return None
    try:
        return json.loads(f'"{double.group(1)}"')
    except json.JSONDecodeError:
        return None


def _scalar(raw: str) -> str | None:
    """A plain or quoted single-line scalar; anything else (block, flow, anchor, empty) reads as absent."""
    if raw == "" or _UNSUPPORTED_VALUE_START.match(raw):
        return None
    if raw.startswith(('"', "'")):
        return _unquote(raw)
    return _TRAILING_COMMENT.sub("", raw).strip() or None


def read_frontmatter(text: str) -> dict[str, str]:
    """The ``name`` and ``description`` of a skill's frontmatter; only plain and quoted single-line values count."""
    match = _FRONTMATTER.match(text)
    found: dict[str, str] = {}
    for line in (match.group(1) if match else "").splitlines():
        key_line = _KEY_LINE.match(line)
        value = _scalar(key_line.group(2)) if key_line else None
        if key_line and value is not None:
            found[key_line.group(1)] = value
    return found


def short_name(name: str) -> str:
    """A skill's name without its leading prefix: e.g. ``example-things`` is shown as ``agent-tool-starter:things``."""
    return name.removeprefix(project.SKILL_PREFIX) or name


def register_skills(ctx: PluginContext, skills_dir: Path) -> None:
    """Register every ``<skills_dir>/<skill>/SKILL.md``; a missing folder registers nothing.

    A skill is named by its frontmatter ``name`` (its folder's name when it has
    none). When two folders give the same name, the first in folder order wins.
    A skill Hermes refuses is logged and skipped, so it never costs the tools.
    """
    if not skills_dir.is_dir():
        return
    registered: set[str] = set()
    for folder in sorted(path for path in skills_dir.iterdir() if path.is_dir()):
        path = folder / SKILL_FILE
        try:
            text = path.read_text(encoding="utf-8-sig")
        except OSError:
            continue
        found = read_frontmatter(text)
        name = short_name(found.get("name", folder.name))
        if name in registered:
            continue
        try:
            ctx.register_skill(name, path, description=found.get("description", ""))
        except (ValueError, OSError) as error:
            logger.warning("%s: skill %s was not registered: %s", project.PLUGIN_NAME, folder.name, error)
            continue
        registered.add(name)
