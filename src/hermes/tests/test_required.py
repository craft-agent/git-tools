"""Tests of the fail-closed, per-call check for required plugins."""

from __future__ import annotations

import json
import unittest
from unittest import mock

from support import StubContext, required


class MissingPluginsTest(unittest.TestCase):
    def test_loaded_plugins_are_left_out_and_missing_names_keep_their_order(self) -> None:
        ctx = StubContext(loaded={"loaded"})
        self.assertEqual(required.missing_plugins(ctx, ["second", "loaded", "first"]), ["second", "first"])
        self.assertEqual(ctx.has_plugin_calls, ["second", "loaded", "first"])

    def test_only_true_means_loaded(self) -> None:
        for value in (True, False, 1, "yes", None):
            with self.subTest(value=value):
                ctx = mock.Mock(has_plugin=mock.Mock(return_value=value))
                self.assertEqual(required.missing_plugins(ctx, ["guard"]), [] if value is True else ["guard"])

    def test_a_check_that_raises_means_missing(self) -> None:
        ctx = mock.Mock(has_plugin=mock.Mock(side_effect=[RuntimeError("unavailable"), True]))
        self.assertEqual(required.missing_plugins(ctx, ["missing", "loaded"]), ["missing"])

    def test_an_absent_or_non_callable_check_means_all_missing(self) -> None:
        ctx = StubContext()
        self.assertFalse(hasattr(ctx, "has_plugin"))
        for context in (ctx, mock.Mock(has_plugin=None), mock.Mock(has_plugin=True)):
            with self.subTest(context=context):
                self.assertEqual(required.missing_plugins(context, ["guard", "other"]), ["guard", "other"])

    def test_a_check_attribute_that_raises_means_missing(self) -> None:
        class BrokenContext:
            @property
            def has_plugin(self):
                raise RuntimeError("unavailable")

        self.assertEqual(required.missing_plugins(BrokenContext(), ["guard"]), ["guard"])


class RequiredGuardTest(unittest.TestCase):
    def test_refusal_is_forbidden_text_followed_by_json_details(self) -> None:
        message, details = required.refusal_text(["guard", "other"]).splitlines()
        self.assertTrue(message.startswith("forbidden: "))
        self.assertIn("guard, other", message)
        self.assertEqual(json.loads(details), {"reason": "missing_plugin", "plugins": ["guard", "other"]})

    def test_no_names_gives_no_guard(self) -> None:
        self.assertIsNone(required.make_guard(StubContext(), []))

    def test_the_guard_checks_loaded_plugins_on_every_call(self) -> None:
        ctx = StubContext(loaded=set())
        guard = required.make_guard(ctx, ["guard"])
        self.assertEqual(guard(), required.refusal_text(["guard"]))
        ctx.loaded.add("guard")
        self.assertIsNone(guard())
        ctx.loaded.remove("guard")
        self.assertEqual(guard(), required.refusal_text(["guard"]))
        self.assertEqual(ctx.has_plugin_calls, ["guard", "guard", "guard"])

    def test_an_unexpected_check_failure_refuses_all_names(self) -> None:
        guard = required.make_guard(StubContext(), ["guard", "other"])
        with mock.patch.object(required, "missing_plugins", side_effect=RuntimeError("unavailable")):
            self.assertEqual(guard(), required.refusal_text(["guard", "other"]))


if __name__ == "__main__":
    unittest.main()
