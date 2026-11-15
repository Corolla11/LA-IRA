import unittest
from unittest.mock import patch

from tools import radiation

DIRECTORIES = '<a href="SOL_04613_04709/">a</a><a href="SOL_04710_04843/">b</a>'
LISTINGS = {
    "SOL_04613_04709/": "".join(
        f'<a href="RAD_RDR_2026_0{sol % 100:02d}_10_00_{sol}_V00.LBL">x</a>' for sol in (4708, 4709)
    ),
    "SOL_04710_04843/": "".join(
        f'<a href="RAD_RDR_2026_0{sol % 100:02d}_10_00_{sol}_V00.LBL">x</a>' for sol in (4710, 4711, 4712)
    ) + '<a href="RAD_RDR_2026_011_10_00_4711_V01.LBL">v1</a>',
}
# Both data files hold the same text: three dose values at 1-based byte offsets 11, 31 and 51.
DATA = b"0123456789" + b"6.00000" + b"." * 13 + b"7.00000" + b"." * 13 + b"2.00000\r\n"
LABEL = "".join(
    f'^OBS00{i}_TOT_DOSE_E_ELEMENT =\n  ("X.TXT", {offset} <BYTES>)\n' for i, offset in enumerate((11, 31, 51))
)


class Response:
    def __init__(self, status: int, text: str = "", content: bytes = b""):
        self.status_code = status
        self.text = text
        self.content = content

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


def fake_get(url: str, headers: dict[str, str] | None = None, timeout: float = 0) -> Response:
    if url == radiation.DATA_URL:
        return Response(200, DIRECTORIES)
    for directory, listing in LISTINGS.items():
        if url == radiation.DATA_URL + directory:
            return Response(200, listing)
    if url.endswith(".LBL"):
        return Response(200, LABEL)
    assert url.endswith(".TXT") and headers is not None
    spans = [tuple(map(int, part.split("-"))) for part in headers["Range"].removeprefix("bytes=").split(",")]
    if len(spans) == 1:
        start, end = spans[0]
        return Response(206, content=DATA[start:end + 1])
    body = b"".join(
        b"\r\n--boundary\r\nContent-type: text/plain\r\nContent-range: bytes "
        + f"{start}-{end}/{len(DATA)}".encode() + b"\r\n\r\n" + DATA[start:end + 1]
        for start, end in spans
    ) + b"\r\n--boundary--\r\n"
    return Response(206, content=body)


class RadiationTest(unittest.TestCase):
    def test_reads_dose_values_at_label_offsets(self):
        with patch.object(radiation.requests, "get", fake_get):
            self.assertEqual(radiation.read_doses("https://x/X.LBL"), [6.0, 7.0, 2.0])

    def test_averages_the_newest_sols_across_directories_and_ignores_older_versions(self):
        with patch.object(radiation.requests, "get", fake_get):
            products = radiation.latest_products(4, None)
            self.assertEqual([sol for sol, _ in products], [4709, 4710, 4711, 4712])
            self.assertTrue(products[2][1].endswith("_V01.LBL"))
            dose = radiation.latest_dose(sols=4)
        self.assertEqual(dose["firstSol"], 4709)
        self.assertEqual(dose["lastSol"], 4712)
        self.assertEqual(dose["observations"], 12)
        self.assertAlmostEqual(dose["rate"], 5.0)

    def test_last_sol_limits_the_window(self):
        with patch.object(radiation.requests, "get", fake_get):
            self.assertEqual([sol for sol, _ in radiation.latest_products(2, 4710)], [4709, 4710])

    def test_rejects_servers_that_ignore_range_requests(self):
        def full_response(url: str, headers: dict[str, str] | None = None, timeout: float = 0) -> Response:
            if url.endswith(".TXT"):
                return Response(200, content=DATA)
            return fake_get(url, headers, timeout)

        with patch.object(radiation.requests, "get", full_response), self.assertRaisesRegex(RuntimeError, "range"):
            radiation.read_doses("https://x/X.LBL")


if __name__ == "__main__":
    unittest.main()
