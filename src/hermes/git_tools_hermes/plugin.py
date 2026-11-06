"""The plugin's entry point."""

from __future__ import annotations

import logging

from .approval import register_approval
from .context import PluginContext
from .listing import list_tools
from . import project
from .runtime import Unavailable, locate_runtime
from .settings import SettingsError, settings_flags
from .skills import register_skills
from .tools import register_tools

logger = logging.getLogger(__name__)


def register(ctx: PluginContext) -> None:
    """Register the tools the settings select, the approval hook and the skills.

    The tools run in the package's command line, so node and ``dist/cli.js``
    must be there and ``list`` must answer. When they are not, or a setting is
    wrong, this logs one warning and registers nothing; it never raises.
    """
    try:
        runtime = locate_runtime()
        flags = settings_flags(ctx)
        tools = list_tools(runtime, flags)
    except (Unavailable, SettingsError) as error:
        logger.warning("%s is not available and registers nothing: %s", project.PLUGIN_NAME, error)
        return

    register_tools(ctx, runtime, tools, flags)
    register_approval(ctx, runtime, tools)
    register_skills(ctx, runtime.skills_dir)
