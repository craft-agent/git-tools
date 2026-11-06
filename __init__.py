"""Loads the plugin package from ``src/hermes/agent_tool_starter_hermes`` for Hermes, which imports this file.

The package is loaded as ``<this module's name>._impl``, so Hermes, which evicts
everything under a plugin's module name when it reloads it or loads it for another
profile, evicts the package too, and each install path gets a package of its own.
"""

import importlib.util
import sys
from pathlib import Path

_NAME = f"{__name__}._impl"
_PACKAGE_DIR = Path(__file__).resolve().parent / "src" / "hermes" / "agent_tool_starter_hermes"


def _evict() -> None:
    """Drop the package and its submodules from ``sys.modules``."""
    for name in list(sys.modules):
        if name == _NAME or name.startswith(f"{_NAME}."):
            sys.modules.pop(name, None)


_spec = importlib.util.spec_from_file_location(
    _NAME, _PACKAGE_DIR / "__init__.py", submodule_search_locations=[str(_PACKAGE_DIR)]
)
_module = importlib.util.module_from_spec(_spec)
_evict()
sys.modules[_NAME] = _module
try:
    _spec.loader.exec_module(_module)
except BaseException:
    _evict()
    raise

register = _module.register
__all__ = ["register"]
