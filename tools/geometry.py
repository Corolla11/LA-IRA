"""Geometry and compatibility formatting for the Mars data source."""

import math
from decimal import ROUND_HALF_UP, Decimal

THEMIS_TILE = (9, 269, 902)


def tile_origin():
    return 34518 - 7, 115554 - 7


def bbox():
    d16 = 180 / 2 ** 16
    row0, col0 = tile_origin()
    return (col0 * d16 - 180, 90 - (row0 + 15) * d16, (col0 + 15) * d16 - 180, 90 - row0 * d16)


def ps_num(v):
    d = Decimal(v)
    q = Decimal(1).scaleb(d.adjusted() - 14)
    return format(d.quantize(q, rounding=ROUND_HALF_UP).normalize(), "f")


def bbox_str():
    return ",".join(ps_num(v) for v in bbox())


def themis_crop(lonW, lonE, latN):
    _, trow, tcol = THEMIS_TILE
    px = (180 / 512) / 256
    x0 = round((lonW + 180 - tcol * (180 / 512)) / px)
    y0 = round((90 - latN - trow * (180 / 512)) / px)
    return x0, y0, round((lonE - lonW) / px)


def crism_crop(lonW, lonE, latN, latS, res, cW, cN):
    x0 = math.floor((lonW - cW) * res)
    x1 = math.ceil((lonE - cW) * res)
    y0 = math.floor((cN - latN) * res)
    y1 = math.ceil((cN - latS) * res)
    return x0, y0, x1 - x0, y1 - y0


def ps_6dec(v):
    s = format(Decimal(ps_num(v)).quantize(Decimal("1e-6"), rounding=ROUND_HALF_UP), "f").rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s
