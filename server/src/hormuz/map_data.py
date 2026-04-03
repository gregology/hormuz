"""Map data — runtime spawn logic and constants.

Spatial data (spawn points, lanes, etc.) is generated from shared/map.yaml.
This module re-exports generated data and provides runtime spawn functions.
"""

import math
import random

# Re-export all generated map data
from hormuz.generated.map_data import (  # noqa: F401
    ESCORT_ZONE_EAST,
    ESCORT_ZONE_WEST,
    EXCLUSION_ZONES,
    GULF_DESTINATION,
    IRAN_SPAWNS,
    LANE_INBOUND,
    LANE_OUTBOUND,
    OMAN_DESTINATION,
    PATROL_ZONES,
    QRF_PATROL_ROUTES,
    QUADCOPTER_SPAWNS,
    STRAIT_CENTER,
    TANKER_SPAWNS,
    US_BASES,
    US_SPAWNS,
)

MAP_WIDTH = 113000.0
MAP_HEIGHT = 81000.0

_SPAWN_MARGIN = 500.0

# Split spawns by group tag
_TANKER_GULF_SPAWNS = [s for s in TANKER_SPAWNS if s.get("group") == "gulf"]
_TANKER_OMAN_SPAWNS = [s for s in TANKER_SPAWNS if s.get("group") == "oman"]
_FRIGATE_GULF_SPAWNS = [s for s in US_SPAWNS if s.get("group") == "gulf"]
_FRIGATE_OMAN_SPAWNS = [s for s in US_SPAWNS if s.get("group") == "oman"]


def _clamp_to_map(x: float, y: float) -> tuple[float, float]:
    x = max(_SPAWN_MARGIN, min(MAP_WIDTH - _SPAWN_MARGIN, x))
    y = max(_SPAWN_MARGIN, min(MAP_HEIGHT - _SPAWN_MARGIN, y))
    return x, y


def _scatter_around(spawn: dict) -> tuple[float, float, float]:
    """Pick a random position within scatter_radius of a spawn point."""
    sx, sy = spawn["position"]
    radius = spawn.get("scatter_radius", 500)
    heading = spawn.get("heading", 0.0)
    angle = random.uniform(0, 2 * math.pi)
    dist = random.uniform(0, radius)
    x = sx + math.cos(angle) * dist
    y = sy + math.sin(angle) * dist
    x, y = _clamp_to_map(x, y)
    heading += random.uniform(-0.26, 0.26)
    return x, y, heading


def random_tanker_spawn() -> tuple[float, float, float]:
    """Return (x, y, heading) for a tanker spawning in the Persian Gulf (heading east)."""
    return _scatter_around(random.choice(_TANKER_GULF_SPAWNS))


def random_oman_spawn() -> tuple[float, float, float]:
    """Return (x, y, heading) for a spawn in the Gulf of Oman (heading west)."""
    return _scatter_around(random.choice(_TANKER_OMAN_SPAWNS))


def random_frigate_gulf_spawn() -> tuple[float, float, float]:
    """Return (x, y, heading) for a frigate spawning in the Gulf."""
    return _scatter_around(random.choice(_FRIGATE_GULF_SPAWNS))


def random_frigate_oman_spawn() -> tuple[float, float, float]:
    """Return (x, y, heading) for a frigate spawning near Oman."""
    return _scatter_around(random.choice(_FRIGATE_OMAN_SPAWNS))


def random_quadcopter_spawn(
    tanker_positions: list[tuple[float, float]],
) -> tuple[float, float, float]:
    """Return (x, y, heading) for a quadcopter, spawning at the launch site closest to a tanker."""
    best_spawn = None
    best_tanker = None
    best_dist_sq = float("inf")

    for spawn in QUADCOPTER_SPAWNS:
        sx, sy = spawn["position"]
        for tx, ty in tanker_positions:
            dx = tx - sx
            dy = ty - sy
            d_sq = dx * dx + dy * dy
            if d_sq < best_dist_sq:
                best_dist_sq = d_sq
                best_spawn = spawn
                best_tanker = (tx, ty)

    if best_spawn is None:
        best_spawn = random.choice(QUADCOPTER_SPAWNS)

    sx, sy = best_spawn["position"]
    radius = best_spawn.get("scatter_radius", 500)
    angle = random.uniform(0, 2 * math.pi)
    dist = random.uniform(0, radius)
    x = sx + math.cos(angle) * dist
    y = sy + math.sin(angle) * dist
    x, y = _clamp_to_map(x, y)

    if best_tanker is not None:
        heading = math.atan2(best_tanker[1] - y, best_tanker[0] - x)
    else:
        heading = math.atan2(STRAIT_CENTER[1] - y, STRAIT_CENTER[0] - x)

    return x, y, heading
