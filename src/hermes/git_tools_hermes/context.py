"""The slice of Hermes' plugin context this package uses."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol


class PluginContext(Protocol):
    """What ``register(ctx)`` is handed; Hermes' ``PluginContext`` provides all of it.

    ``session_surface()`` is read when present (see ``approval.session_surface``).
    ``has_plugin(name)`` is read when present to check required plugins (see ``required.missing_plugins``).
    """

    def get_config(self, key: str, default: Any = None) -> Any:
        """Read ``plugins.entries.<plugin>.settings.<key>``."""

    def register_tool(
        self,
        name: str,
        toolset: str,
        schema: dict[str, Any],
        handler: Callable[..., str],
        description: str = "",
        emoji: str = "",
    ) -> Any:
        """Add a tool to the agent."""

    def register_hook(self, hook_name: str, callback: Callable[..., Any]) -> Any:
        """Add a lifecycle hook callback."""

    def register_skill(self, name: str, path: Path, description: str = "") -> Any:
        """Add a read-only skill, shown as ``<plugin>:<name>``."""
