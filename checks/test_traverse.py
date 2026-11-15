import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import prepare_data


class WaypointResponse:
    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict[str, list[dict[str, dict[str, int | float | str]]]]:
        return {
            "features": [
                {"properties": {"sol": 4671, "lat": -4.8, "lon": 137.38}},
                {"properties": {"sol": 4669, "lat": -4.8, "lon": 137.38}},
                {"properties": {"sol": "Infinity", "lat": -4.8, "lon": 137.38}},
                {"properties": {"sol": 5000, "lat": 0, "lon": 0}},
            ]
        }


class TraverseTest(unittest.TestCase):
    def test_latest_waypoints_inside_area_are_not_capped_at_reference_sol(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(prepare_data.requests, "get", return_value=WaypointResponse()):
                prepare_data.step_traverse(Path(temp))

            points = json.loads((Path(temp) / "traverse.json").read_text(encoding="utf-8"))
            self.assertEqual(points, [[4669, -4.8, 137.38], [4671, -4.8, 137.38]])


if __name__ == "__main__":
    unittest.main()
