"""What the plugin's tests share: the package loaded by path, a stub plugin context and a fake command line.

Not a test module: ``unittest`` collects ``test*.py`` only.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
PACKAGE_PATH = Path("src") / "hermes" / "agent_tool_starter_hermes"
FAKE_CLI = Path(__file__).resolve().parent / "fake_cli.py"

CWD = "/work/tree"
IMPL = "_impl"
ROOT_NAME = "hermes_plugins_agent_tool_starter"


def load_root(root: Path, name: str) -> types.ModuleType:
    """Import ``<root>/__init__.py`` as module ``name``, the way Hermes imports a directory plugin."""
    spec = importlib.util.spec_from_file_location(name, root / "__init__.py", submodule_search_locations=[str(root)])
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def evict(name: str) -> None:
    """Drop ``name`` and its submodules from ``sys.modules``."""
    for loaded in list(sys.modules):
        if loaded == name or loaded.startswith(f"{name}."):
            sys.modules.pop(loaded, None)


def copy_plugin(destination: Path) -> Path:
    """Copy the files Hermes loads into ``destination``: the root ``__init__.py``, ``plugin.yaml`` and the package."""
    destination.mkdir(parents=True)
    for name in ("__init__.py", "plugin.yaml"):
        shutil.copy(ROOT / name, destination / name)
    shutil.copytree(ROOT / PACKAGE_PATH, destination / PACKAGE_PATH, ignore=shutil.ignore_patterns("__pycache__"))
    return destination


load_root(ROOT, ROOT_NAME)
package = sys.modules[f"{ROOT_NAME}.{IMPL}"]
approval, listing, plugin, project, runtime, settings, skills, tools = (
    package.approval,
    package.listing,
    package.plugin,
    package.project,
    package.runtime,
    package.settings,
    package.skills,
    package.tools,
)


def tool_entry(tool_id: str, toolset: str, write_class: str, title: str | None = None) -> dict[str, Any]:
    """One element of the array ``list`` answers with."""
    return {
        "id": tool_id,
        "title": title or f"Title of {tool_id}",
        "description": f"Description of {tool_id}",
        "toolset": toolset,
        "class": write_class,
        "annotations": {},
        "input_schema": {"type": "object", "properties": {"target": {"type": "string"}}, "additionalProperties": False},
        "output_schema": {"type": "object"},
    }


LISTING = [
    tool_entry("demo_thing_read", "things", "read"),
    tool_entry("demo_thing_create", "things", "add", "Create a thing"),
    tool_entry("demo_widget_update", "widgets", "administrative", "Update a widget"),
    tool_entry("demo_item_add", "items", "add"),
    tool_entry("demo_gadget_edit", "gadgets", "overwrite"),
    tool_entry("demo_bundle_publish", "bundles", "administrative"),
    tool_entry("demo_task_run", "tasks", "idempotent"),
]


class StubContext:
    """Records what ``register`` adds, as Hermes' plugin context would take it."""

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config = config or {}
        self.tools: dict[str, dict[str, Any]] = {}
        self.hooks: list[tuple[str, Any]] = []
        self.skills: list[tuple[str, Path, str]] = []

    def get_config(self, key: str, default: Any = None) -> Any:
        return self.config.get(key, default)

    def register_tool(self, name: str, toolset: str, schema: dict[str, Any], handler: Any, **kwargs: Any) -> None:
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, **kwargs}

    def register_hook(self, hook_name: str, callback: Any) -> None:
        self.hooks.append((hook_name, callback))

    def register_skill(self, name: str, path: Path, description: str = "") -> None:
        self.skills.append((name, Path(path), description))


class FakeCliCase(unittest.TestCase):
    """A case whose plugin runs ``fake_cli.py`` in place of ``node dist/cli.js``."""

    replies: dict[str, dict[str, Any]]

    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="agent-tool-starter-hermes-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.log = self.dir / "calls.jsonl"
        self.fixture = self.dir / "fixture.json"
        self.skills_dir = self.dir / "skills"
        self.runtime = runtime.Runtime(node=sys.executable, cli=FAKE_CLI, skills_dir=self.skills_dir)
        self.replies = {"list": {"stdout": json.dumps(LISTING)}}
        env = mock.patch.dict("os.environ", {"FAKE_CLI_FIXTURE": str(self.fixture)})
        env.start()
        self.addCleanup(env.stop)
        for module in (tools, approval):
            patcher = mock.patch.object(module, "agent_cwd", return_value=CWD)
            patcher.start()
            self.addCleanup(patcher.stop)
        locate = mock.patch.object(plugin, "locate_runtime", side_effect=lambda: self.runtime)
        locate.start()
        self.addCleanup(locate.stop)

    def reply(self, key: str, **fields: Any) -> None:
        self.replies[key] = fields

    def calls(self) -> list[dict[str, Any]]:
        self.write_fixture()
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def write_fixture(self) -> None:
        self.fixture.write_text(json.dumps({"log": str(self.log), "replies": self.replies}), encoding="utf-8")

    def register(self, config: dict[str, Any] | None = None) -> StubContext:
        ctx = StubContext(config)
        self.write_fixture()
        plugin.register(ctx)
        return ctx
