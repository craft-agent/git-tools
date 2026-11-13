"""The plugin's entry point."""

from __future__ import annotations

import logging

from .approval import register_approval
from .context import PluginContext
from .listing import list_tools
from . import project
from .required import make_guard
from .runtime import Unavailable, locate_runtime
from .settings import (
    SettingsError, emoji_setting, grant_flags, language_setting, option_flags, require_plugins_setting, settings_flags,
)
from .skills import register_skills
from .tools import register_tools

logger = logging.getLogger(__name__)


def register(ctx: PluginContext) -> None:
    """Register the selected tools, approval hook and skills, guarding writes for required plugins.

    A skill linked to a toolset is registered only when a selected tool has it.

    The tools run in the package's command line, so node and ``dist/cli.js``
    must be there and ``list`` must answer. When they are not, or a setting is
    wrong, this logs one warning and registers nothing; it never raises.
    """
    try:
        runtime = locate_runtime()
        flags = settings_flags(ctx)
        required_names = require_plugins_setting(ctx)
        tools = list_tools(runtime, flags)
    except (Unavailable, SettingsError) as error:
        logger.warning("%s is not available and registers nothing: %s", project.PLUGIN_NAME, error)
        return

    guard = make_guard(ctx, required_names)
    register_tools(ctx, runtime, tools, flags, emoji_setting(ctx), guard=guard)
    register_approval(ctx, runtime, tools, language_setting(ctx), [*option_flags(ctx), *grant_flags(ctx)], guard=guard)
    register_skills(ctx, runtime.skills_dir, {tool.toolset for tool in tools})
