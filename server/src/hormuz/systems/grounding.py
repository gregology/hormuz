"""Grounding processor — prevents ships from entering land, damages grounded vessels."""

import math

import esper

from hormuz.components import Health, Transform, VehiclePhysics
from hormuz.generated.terrain_grid import is_land

# How far ahead (in game units) to probe for land
PROBE_DISTANCE = 150.0

# Push-back speed when grounded (game units / second)
PUSHBACK_SPEED = 8.0

# Ticks on land before hull breaches start
GROUNDING_GRACE_TICKS = 3  # 0.15 seconds at 20Hz

# Hull breaches per tick while hard-grounded
GROUNDING_BREACH_RATE = 1

# Ticks off land before grounding counter resets — prevents oscillation at
# coastlines from resetting the grace period every tick.
GROUNDING_COOLDOWN_TICKS = 20  # 1 second at 20Hz


class GroundingProcessor(esper.Processor):
    """Check non-airborne entities against terrain and push them off land.

    Runs after PhysicsProcessor (which moves entities) and before CollisionProcessor.
    """

    def __init__(self) -> None:
        super().__init__()
        # Track how long each entity has been on land (entity_id -> tick count)
        self._grounded_ticks: dict[int, int] = {}
        # Track how long off land before resetting counter
        self._offland_ticks: dict[int, int] = {}

    def process(self, dt: float = 0.05) -> None:
        still_grounded: set[int] = set()

        for ent, (tf, phys, health) in esper.get_components(Transform, VehiclePhysics, Health):
            if phys.airborne or health.hp <= 0:
                continue

            if not is_land(tf.x, tf.y):
                # Not on land — only reset grounding counter after sustained time off land
                if ent in self._grounded_ticks:
                    off = self._offland_ticks.get(ent, 0) + 1
                    if off >= GROUNDING_COOLDOWN_TICKS:
                        del self._grounded_ticks[ent]
                        self._offland_ticks.pop(ent, None)
                    else:
                        self._offland_ticks[ent] = off
                continue

            still_grounded.add(ent)
            self._offland_ticks.pop(ent, None)  # back on land, reset off-land counter

            # Entity is on land — push it toward open water
            escape_heading = self._find_water_direction(tf.x, tf.y, phys.size)
            if escape_heading is not None:
                tf.x += math.cos(escape_heading) * PUSHBACK_SPEED * dt
                tf.y += math.sin(escape_heading) * PUSHBACK_SPEED * dt

            # Kill forward speed and drift
            tf.speed *= 0.5
            tf.drift *= 0.5
            tf.angular_velocity *= 0.5

            # Track grounding duration
            ticks = self._grounded_ticks.get(ent, 0) + 1
            self._grounded_ticks[ent] = ticks

            # Hard grounding — start damaging hull
            if ticks > GROUNDING_GRACE_TICKS:
                tf.hull_breaches += GROUNDING_BREACH_RATE
                if tf.breach_side == 0.0:
                    tf.breach_side = 1.0  # list to starboard by default

        # Clean up tracking for entities no longer grounded
        for ent in list(self._grounded_ticks):
            if ent not in still_grounded and ent not in self._offland_ticks:
                del self._grounded_ticks[ent]

    def _find_water_direction(self, x: float, y: float, size: float) -> float | None:
        """Sample 8 directions around the entity and return heading toward nearest water."""
        probe = max(PROBE_DISTANCE, size * 0.5)
        best_heading = None

        for i in range(8):
            angle = i * math.pi / 4  # 0, 45, 90, ... 315 degrees
            px = x + math.cos(angle) * probe
            py = y + math.sin(angle) * probe
            if not is_land(px, py):
                if best_heading is None:
                    best_heading = angle

        # If no water found at probe distance, try farther out
        if best_heading is None:
            far_probe = probe * 3
            for i in range(8):
                angle = i * math.pi / 4
                px = x + math.cos(angle) * far_probe
                py = y + math.sin(angle) * far_probe
                if not is_land(px, py):
                    if best_heading is None:
                        best_heading = angle

        return best_heading
