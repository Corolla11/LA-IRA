import base64
import unittest
from pathlib import Path
from unittest.mock import patch

from tools import adapters, live
from tools.radiation import RadiationDose

DOSE: RadiationDose = {"rate": 6.5, "firstSol": 4839, "lastSol": 4843, "observations": 400}


def fake_prepare_source(
    body: adapters.BodyProfile, src: adapters.Source, out: Path, url: str | None = None, with_meta: bool = True,
) -> None:
    assert with_meta is False
    (out / {"elevation": "elev.txt", "optical": "hirise.jpg"}[src["id"]]).write_bytes(
        base64.b64encode(b"\x00\x00\x80\x3f") if src["id"] == "elevation" else b"jpeg"
    )


class LiveLayerTest(unittest.TestCase):
    def test_elevation_is_served_as_raw_floats_and_images_unchanged(self):
        with patch.object(adapters, "prepare_source", fake_prepare_source):
            elevation = live.render_layer("mars", "elevation")
            optical = live.render_layer("mars", "optical")
        self.assertEqual(elevation, live.Rendered(b"\x00\x00\x80\x3f", "application/octet-stream"))
        self.assertEqual(optical, live.Rendered(b"jpeg", "image/jpeg"))

    def test_unknown_bodies_and_layers_are_rejected_before_fetching(self):
        for body, name in (("../mars", "elevation"), ("mars", "bogus"), ("mars", "minerals-x")):
            with self.subTest(body=body, name=name), patch.object(adapters, "prepare_source") as prepare:
                with self.assertRaises((LookupError, ValueError)):
                    live.render_layer(body, name)
                prepare.assert_not_called()

    def test_radiation_is_placed_at_the_last_in_area_waypoint_of_the_dose_period(self):
        points: list[list[int | float]] = [
            [4700, 1.0, 2.0], [4839, -4.81, 137.38], [4841, -4.82, 137.39], [5000, -4.83, 137.4],
        ]
        with patch.object(live, "latest_dose", return_value=DOSE), \
                patch.object(live, "latest_traverse", return_value=points):
            current = live.current_radiation("mars")
        self.assertEqual((current["sol"], current["lat"], current["lng"]), (4841, -4.82, 137.39))
        self.assertEqual(current["rate"], 6.5)

    def test_radiation_is_unavailable_when_the_rover_left_the_area(self):
        with patch.object(live, "latest_dose", return_value=DOSE), \
                patch.object(live, "latest_traverse", return_value=[[4700, 1.0, 2.0]]), \
                self.assertRaisesRegex(ValueError, "outside"):
            live.current_radiation("mars")
        with self.assertRaises(LookupError):
            live.current_radiation("moon")


if __name__ == "__main__":
    unittest.main()
