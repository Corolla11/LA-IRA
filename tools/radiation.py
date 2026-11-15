"""Current Curiosity RAD dose rate from the PDS Planetary Plasma Interactions archive.

Each daily product is a ~70 MB text file, so the dose values are read with HTTP range requests at the byte
offsets declared in the product label instead of downloading the files."""
import math
import re
from concurrent.futures import ThreadPoolExecutor
from typing import TypedDict

import requests

DATA_URL = "https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/DATA/"
RANGES_PER_REQUEST = 100
DOSE_BYTES = 7  # width of the ASCII_REAL TOT_DOSE_E element declared in the labels

_DIRECTORY = re.compile(r"SOL_(\d{5})_(\d{5})/")
_PRODUCT = re.compile(r"RAD_RDR_\d{4}_\d{3}_\d{2}_\d{2}_(\d{4})_V(\d{2})\.LBL")
_DOSE_ELEMENT = re.compile(r'\^OBS\d+_TOT_DOSE_E_ELEMENT\s*=\s*\(\s*"[^"]+"\s*,\s*(\d+)\s*<BYTES>\s*\)')
_PART = re.compile(rb"\r\n\r\n(.*?)\r\n--", re.DOTALL)


class RadiationDose(TypedDict):
    rate: float
    firstSol: int
    lastSol: int
    observations: int


def _get_text(url: str) -> str:
    response = requests.get(url, timeout=60)
    response.raise_for_status()
    return response.text


def latest_products(sols: int, last_sol: int | None) -> list[tuple[int, str]]:
    """(sol, label URL) of the newest `sols` daily products, newest last."""
    directories = sorted({match.group(0) for match in _DIRECTORY.finditer(_get_text(DATA_URL))}, reverse=True)
    products: dict[int, tuple[int, str]] = {}
    for directory in directories:
        if len(products) >= sols:
            break
        for match in _PRODUCT.finditer(_get_text(DATA_URL + directory)):
            sol, version = int(match.group(1)), int(match.group(2))
            if last_sol is not None and sol > last_sol:
                continue
            if sol not in products or version > products[sol][0]:
                products[sol] = (version, DATA_URL + directory + match.group(0))
    newest = sorted(products)[-sols:]
    return [(sol, products[sol][1]) for sol in newest]


def read_doses(label_url: str) -> list[float]:
    offsets = [int(match.group(1)) for match in _DOSE_ELEMENT.finditer(_get_text(label_url))]
    data_url = label_url.removesuffix(".LBL") + ".TXT"
    doses: list[float] = []
    for start in range(0, len(offsets), RANGES_PER_REQUEST):
        chunk = offsets[start:start + RANGES_PER_REQUEST]
        # PDS byte offsets are 1-based; HTTP ranges are 0-based and inclusive.
        ranges = ",".join(f"{offset - 1}-{offset - 2 + DOSE_BYTES}" for offset in chunk)
        response = requests.get(data_url, headers={"Range": f"bytes={ranges}"}, timeout=120)
        if response.status_code != 206:
            raise RuntimeError(f"PDS server ignored the range request (HTTP {response.status_code})")
        if len(chunk) == 1:
            parts = [response.content]
        else:
            parts = [match.group(1) for match in _PART.finditer(response.content)]
        for part in parts:
            try:
                value = float(part.decode("ascii").strip())
            except ValueError:
                continue
            if math.isfinite(value) and value > 0:
                doses.append(value)
    return doses


def latest_dose(sols: int = 5, last_sol: int | None = None) -> RadiationDose:
    """Mean RAD E dose rate (microGray/hour) over the newest `sols` sols available, optionally up to last_sol."""
    products = latest_products(sols, last_sol)
    if not products:
        raise ValueError("no RAD products found")

    def doses_of(product: tuple[int, str]) -> list[float]:
        return read_doses(product[1])

    with ThreadPoolExecutor(len(products)) as pool:
        per_sol = list(pool.map(doses_of, products))
    doses = [dose for sol_doses in per_sol for dose in sol_doses]
    if not doses:
        raise ValueError("RAD products contain no dose values")
    return {
        "rate": sum(doses) / len(doses),
        "firstSol": products[0][0],
        "lastSol": products[-1][0],
        "observations": len(doses),
    }
