"""Danger scent — shared spatial memory of recent attack locations.

Emitted by combat when tankers take damage. Sensed by bot AI:
frigates are attracted (rush to defend), tankers are repelled (drift away).
Entries decay linearly over DANGER_SCENT_DURATION seconds.
"""

import time

DANGER_SCENT_DURATION = 60.0

_scents: list[tuple[float, float, float]] = []


def emit_danger_scent(x: float, y: float) -> None:
    """Record a danger event (hull breach, death) at this location."""
    _scents.append((x, y, time.monotonic()))


def prune_danger_scents() -> None:
    """Remove expired scent entries."""
    cutoff = time.monotonic() - DANGER_SCENT_DURATION
    _scents[:] = [(x, y, t) for x, y, t in _scents if t > cutoff]


def nearest_danger(
    x: float, y: float, max_range_sq: float
) -> tuple[float, float, float] | None:
    """Return (dx, dy, strength) toward the nearest active danger scent, or None.

    Strength is 1.0 at emission time, decaying linearly to 0.0 at expiry.
    """
    now = time.monotonic()
    best_dist_sq = max_range_sq
    best: tuple[float, float, float] | None = None

    for sx, sy, st in _scents:
        dx = sx - x
        dy = sy - y
        d_sq = dx * dx + dy * dy
        if d_sq < best_dist_sq:
            age = now - st
            strength = max(0.0, 1.0 - age / DANGER_SCENT_DURATION)
            if strength > 0:
                best_dist_sq = d_sq
                best = (dx, dy, strength)

    return best


def clear_all() -> None:
    """Clear all scents (for testing)."""
    _scents.clear()
