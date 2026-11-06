"""Tests of loading the plugin through the root ``__init__.py``, the way Hermes does."""

from __future__ import annotations

import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path

from support import IMPL, PACKAGE_PATH, ROOT, copy_plugin, evict, load_root


class RootModuleTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="agent-tool-starter-root-")).resolve()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def load(self, root: Path, name: str) -> types.ModuleType:
        self.addCleanup(evict, name)
        return load_root(root, name)

    def test_loads_the_package_under_the_importing_modules_name_and_exposes_register(self) -> None:
        name = "hermes_plugins_loads"
        root_module = self.load(ROOT, name)
        impl = sys.modules[f"{name}.{IMPL}"]
        self.assertTrue(callable(root_module.register))
        self.assertIs(root_module.register, impl.register)
        self.assertEqual(impl.__name__, f"{name}.{IMPL}")
        self.assertEqual(Path(impl.__file__).resolve(), (ROOT / PACKAGE_PATH / "__init__.py").resolve())
        self.assertEqual(impl.plugin.__name__, f"{name}.{IMPL}.plugin")
        self.assertNotIn("agent_tool_starter_hermes", sys.modules)

    def test_two_install_paths_each_get_a_package_that_knows_its_own_directory(self) -> None:
        first_dir = copy_plugin(self.dir / "first")
        second_dir = copy_plugin(self.dir / "second")
        first_name, second_name = "hermes_plugins_first", "hermes_plugins_second__home_0a1b"
        first = self.load(first_dir, first_name)
        second = self.load(second_dir, second_name)

        first_impl, second_impl = sys.modules[f"{first_name}.{IMPL}"], sys.modules[f"{second_name}.{IMPL}"]
        self.assertIsNot(first_impl, second_impl)
        self.assertIsNot(first.register, second.register)
        self.assertIsNot(first_impl.runtime, second_impl.runtime)
        self.assertEqual(first_impl.runtime.PLUGIN_DIR, first_dir)
        self.assertEqual(second_impl.runtime.PLUGIN_DIR, second_dir)
        self.assertEqual(Path(first_impl.__file__).resolve(), (first_dir / PACKAGE_PATH / "__init__.py").resolve())
        self.assertEqual(Path(second_impl.__file__).resolve(), (second_dir / PACKAGE_PATH / "__init__.py").resolve())

    def test_what_hermes_evicts_under_the_plugins_name_takes_the_package_with_it(self) -> None:
        name = "hermes_plugins_evicted"
        self.load(ROOT, name)
        stale = sys.modules[f"{name}.{IMPL}"]
        evict(name)
        self.assertEqual([loaded for loaded in sys.modules if loaded.startswith(name)], [])
        self.load(ROOT, name)
        self.assertIsNot(sys.modules[f"{name}.{IMPL}"], stale)

    def test_loading_again_under_one_name_replaces_the_package(self) -> None:
        name = "hermes_plugins_reloaded"
        self.load(ROOT, name)
        stale = sys.modules[f"{name}.{IMPL}"]
        self.load(ROOT, name)
        fresh = sys.modules[f"{name}.{IMPL}"]
        self.assertIsNot(fresh, stale)
        self.assertIs(sys.modules[f"{name}.{IMPL}.plugin"], fresh.plugin)

    def test_a_failed_load_leaves_no_half_initialised_module_behind(self) -> None:
        broken_dir = copy_plugin(self.dir / "broken")
        with (broken_dir / PACKAGE_PATH / "plugin.py").open("a", encoding="utf-8") as plugin_file:
            plugin_file.write('\nraise RuntimeError("boom")\n')
        name = "hermes_plugins_broken"
        good = self.load(ROOT, "hermes_plugins_still_good")
        self.addCleanup(evict, name)

        with self.assertRaisesRegex(RuntimeError, "boom"):
            load_root(broken_dir, name)

        self.assertEqual([loaded for loaded in sys.modules if loaded.startswith(f"{name}.")], [])
        self.assertIn("hermes_plugins_still_good._impl", sys.modules)
        self.assertTrue(callable(good.register))

    def test_a_failed_load_does_not_leave_a_package_a_retry_would_inherit(self) -> None:
        broken_dir = copy_plugin(self.dir / "retry")
        plugin_file = broken_dir / PACKAGE_PATH / "plugin.py"
        original = plugin_file.read_text(encoding="utf-8")
        plugin_file.write_text(original + '\nraise RuntimeError("boom")\n', encoding="utf-8")
        name = "hermes_plugins_retry"
        self.addCleanup(evict, name)
        with self.assertRaises(RuntimeError):
            load_root(broken_dir, name)

        plugin_file.write_text(original, encoding="utf-8")
        fixed = self.load(broken_dir, name)
        self.assertTrue(callable(fixed.register))


if __name__ == "__main__":
    unittest.main()
