"""Offline safety tests for the explicitly invoked bounded production probe."""

import importlib.util
import unittest
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "production_provider_probe.py"
spec = importlib.util.spec_from_file_location("production_provider_probe", MODULE_PATH)
if not spec or not spec.loader:
    raise RuntimeError("Probe module not found")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeSafetyTests(unittest.TestCase):
    def test_stages_are_explicit_small_and_increasing(self):
        self.assertEqual(probe.parse_stages("1,5,10"), [1, 5, 10])
        for value in ["100", "0", "1,5,1", "5,5", "", "1,11"]:
            with pytest.raises(ValueError):
                probe.parse_stages(value)

    def test_probe_stops_on_any_failed_slow_or_empty_stream(self):
        good = {"status": 206, "firstByteMs": 500, "bytesRead": 65536}
        self.assertTrue(probe.accepted(good))
        for changed in [
            {"status": 429},
            {"status": 401},
            {"firstByteMs": 8001},
            {"bytesRead": 0},
            {"error": "ReadTimeout"},
        ]:
            self.assertFalse(probe.accepted({**good, **changed}))
