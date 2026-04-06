"""Coalition threat picture — shared radar detections across allied vessels.

Each tick, every radar-equipped vessel scans for enemies within its detection
range. Detections are pooled by coalition:
  - "us" coalition: frigates share with each other
  - "civilian_us" sharing: tanker detections are shared with US frigates
  - Iran has no radar-equipped vessels, so no coalition sharing

Consumers (bot_ai) query the threat picture to find which tankers have
nearby threats, enabling frigates to prioritize endangered tankers.
"""

from hormuz.generated.vehicles import DETECTION_RANGE

# Per-tick threat picture: list of (target_entity, target_x, target_y, target_vehicle_type)
# Built once per tick, read by bot_ai.
_coalition_us_threats: list[tuple[int, float, float, str]] = []


def build_threat_picture(
    radar_vessels: list[tuple[str, float, float, str]],
    enemy_vessels: list[tuple[int, float, float, str]],
) -> None:
    """Build the coalition threat picture for this tick.

    Args:
        radar_vessels: [(vehicle_type, x, y, faction), ...] for all alive radar-equipped vessels.
        enemy_vessels: [(entity_id, x, y, vehicle_type), ...] for all alive enemy targets.
    """
    _coalition_us_threats.clear()

    seen: set[int] = set()

    for obs_type, obs_x, obs_y, obs_faction in radar_vessels:
        det_ranges = DETECTION_RANGE.get(obs_type)
        if det_ranges is None:
            continue

        # Only US and civilian vessels contribute to the US coalition picture
        if obs_faction not in ("us", "civilian"):
            continue

        for tgt_ent, tgt_x, tgt_y, tgt_type in enemy_vessels:
            if tgt_ent in seen:
                continue
            det_range = det_ranges.get(tgt_type)
            if det_range is None:
                continue
            dx = tgt_x - obs_x
            dy = tgt_y - obs_y
            if dx * dx + dy * dy <= det_range * det_range:
                seen.add(tgt_ent)
                _coalition_us_threats.append((tgt_ent, tgt_x, tgt_y, tgt_type))


def get_threats_near(
    x: float, y: float, radius_sq: float
) -> list[tuple[int, float, float, str]]:
    """Return all coalition-detected threats within radius of a point.

    Used by frigate escort scoring to find how many enemies are near a tanker.
    """
    result = []
    for tgt_ent, tgt_x, tgt_y, tgt_type in _coalition_us_threats:
        dx = tgt_x - x
        dy = tgt_y - y
        if dx * dx + dy * dy <= radius_sq:
            result.append((tgt_ent, tgt_x, tgt_y, tgt_type))
    return result


def get_all_us_threats() -> list[tuple[int, float, float, str]]:
    """Return the full US coalition threat picture for this tick."""
    return _coalition_us_threats


def clear() -> None:
    """Clear the threat picture (for testing)."""
    _coalition_us_threats.clear()
