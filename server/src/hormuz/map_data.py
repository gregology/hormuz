"""Map data — spawn points, shipping lanes, exits.

Ported from client/src/map/data.ts. Uses the same coordinate system:
  Origin (0, 0) = top-left (northwest corner)
  X axis = east (increasing longitude)
  Y axis = south (decreasing latitude)
"""

import math
import random

ORIGIN_LON = 47.5
ORIGIN_LAT = 30.5
LON_SCALE = 9708
LAT_SCALE = 10800


def geo(lat: float, lon: float) -> tuple[float, float]:
    return (
        round((lon - ORIGIN_LON) * LON_SCALE),
        round((ORIGIN_LAT - lat) * LAT_SCALE),
    )


# ---------------------------------------------------------------------------
# Spawn points
# ---------------------------------------------------------------------------

IRAN_SPAWNS = [
    {"position": geo(27.18, 56.28), "heading": math.pi, "label": "Bandar Abbas"},
    {"position": geo(26.95, 55.50), "heading": math.pi * 0.5, "label": "Iran Coast West"},
    {"position": geo(27.05, 56.80), "heading": math.pi * 0.6, "label": "Iran Coast East"},
    {"position": geo(26.85, 55.80), "heading": math.pi * 0.5, "label": "Qeshm West"},
    {"position": geo(26.80, 56.20), "heading": math.pi * 0.5, "label": "Qeshm East"},
    {"position": geo(27.05, 56.45), "heading": math.pi * 0.5, "label": "Hormuz Island"},
    {"position": geo(26.86, 56.35), "heading": math.pi * 0.5, "label": "Larak Island"},
    {"position": geo(25.88, 55.02), "heading": math.pi * 0.5, "label": "Abu Musa Island"},
]

TANKER_SPAWNS = [
    {"position": geo(26.50, 51.50), "heading": 0.0, "label": "Persian Gulf Port A"},
    {"position": geo(26.00, 52.00), "heading": 0.0, "label": "Persian Gulf Port B"},
    {"position": geo(25.50, 53.00), "heading": 0.0, "label": "Persian Gulf Port C"},
    {"position": geo(26.10, 58.80), "heading": math.pi, "label": "Gulf of Oman Arrival"},
]

TANKER_EXITS = [
    geo(26.10, 58.90),  # Gulf of Oman exit
    geo(26.40, 51.00),  # Persian Gulf port
]

# ---------------------------------------------------------------------------
# Shipping lanes (Traffic Separation Scheme)
# ---------------------------------------------------------------------------


def _geo_line(coords: list[tuple[float, float]]) -> list[tuple[float, float]]:
    return [geo(lat, lon) for lat, lon in coords]


# ---------------------------------------------------------------------------
# Area-based spawning (MVP)
# ---------------------------------------------------------------------------

# Tankers spawn in a region near the strait entrance, heading east
TANKER_SPAWN_CENTER = (71300.0, 46800.0)
TANKER_SPAWN_RADIUS = 3000.0  # scatter within this radius
TANKER_SPAWN_HEADING = 0.0  # east


def random_tanker_spawn() -> tuple[float, float, float]:
    """Return (x, y, heading) for a random tanker spawn in the strait area."""
    angle = random.uniform(0, 2 * math.pi)
    dist = random.uniform(0, TANKER_SPAWN_RADIUS)
    x = TANKER_SPAWN_CENTER[0] + math.cos(angle) * dist
    y = TANKER_SPAWN_CENTER[1] + math.sin(angle) * dist
    # Slight heading variation (+/- 15 degrees)
    heading = TANKER_SPAWN_HEADING + random.uniform(-0.26, 0.26)
    return x, y, heading


# ---------------------------------------------------------------------------
# Shipping lanes (Traffic Separation Scheme)
# ---------------------------------------------------------------------------

LANE_INBOUND = _geo_line(
    [
        (25.20, 58.50),
        (25.30, 58.00),
        (25.50, 57.50),
        (25.80, 57.00),
        (26.30, 56.80),
        (26.48, 56.50),
        (26.55, 56.20),
        (26.57, 55.90),
        (26.55, 55.60),
        (26.50, 55.00),
    ]
)

LANE_OUTBOUND = _geo_line(
    [
        (26.45, 55.00),
        (26.50, 55.60),
        (26.52, 55.90),
        (26.48, 56.20),
        (26.40, 56.50),
        (26.20, 56.80),
        (25.60, 57.00),
        (25.30, 57.50),
        (25.10, 58.00),
        (25.00, 58.50),
    ]
)
