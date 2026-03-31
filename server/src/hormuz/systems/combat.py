"""Combat processor — shahed kamikaze attacks on tankers.

Uses bounding-circle broad phase + SAT narrow phase from the collision system
so that hits only trigger on actual polygon contact. Shahed dies on impact;
tanker receives hull breaches and floods progressively.
"""

import math

import esper

from hormuz.components import (
    BotControl,
    Collidable,
    Health,
    PlayerControl,
    RespawnTimer,
    Transform,
    VehiclePhysics,
)
from hormuz.systems.collision import _sat_collision, _transform_polygon


class CombatProcessor(esper.Processor):
    def __init__(self) -> None:
        super().__init__()
        # Events generated this tick — consumed by networking
        self.events: list[dict] = []

    def process(self, dt: float = 0.05) -> None:
        self.events.clear()

        shaheds = [
            (ent, tf, phys, col)
            for ent, (tf, phys, col, health) in esper.get_components(
                Transform, VehiclePhysics, Collidable, Health
            )
            if phys.vehicle_type == "shahed" and health.hp > 0
        ]

        tankers = [
            (ent, tf, phys, col)
            for ent, (tf, phys, col, health) in esper.get_components(
                Transform, VehiclePhysics, Collidable, Health
            )
            if phys.vehicle_type == "oil_tanker" and health.hp > 0
        ]

        hit_shaheds: set[int] = set()

        for s_ent, s_tf, s_phys, s_col in shaheds:
            if s_ent in hit_shaheds:
                continue
            for t_ent, t_tf, t_phys, t_col in tankers:
                # Broad phase: bounding circles
                dx = t_tf.x - s_tf.x
                dy = t_tf.y - s_tf.y
                dist_sq = dx * dx + dy * dy
                br_sum = (
                    s_col.bounding_radius * s_phys.size
                    + t_col.bounding_radius * t_phys.size
                )
                if dist_sq > br_sum * br_sum:
                    continue

                # Narrow phase: SAT polygon intersection
                s_poly = _transform_polygon(
                    s_col.vertices, s_tf.x, s_tf.y, s_tf.heading, s_phys.size
                )
                t_poly = _transform_polygon(
                    t_col.vertices, t_tf.x, t_tf.y, t_tf.heading, t_phys.size
                )
                result = _sat_collision(
                    s_poly, t_poly, s_tf.x, s_tf.y, t_tf.x, t_tf.y
                )
                if result is None:
                    continue

                _, _, _, contact_x, contact_y = result

                # Shahed dies on impact
                self._kill(s_ent)
                hit_shaheds.add(s_ent)

                # Tanker receives hull breaches — determine which side was hit
                breach_side = self._breach_side(t_tf, contact_x, contact_y)
                self._breach_tanker(t_ent, t_tf, breach_side)

                self.events.append({
                    "type": "explosion",
                    "x": contact_x,
                    "y": contact_y,
                })
                break

    @staticmethod
    def _breach_side(tf: Transform, cx: float, cy: float) -> float:
        """Determine which side of the hull was hit (-1 port, +1 starboard)."""
        # Vector from tanker center to contact point
        dx = cx - tf.x
        dy = cy - tf.y
        # Cross product with heading direction gives lateral side
        cross = math.cos(tf.heading) * dy - math.sin(tf.heading) * dx
        if cross > 0:
            return 1.0  # starboard
        if cross < 0:
            return -1.0  # port
        return 0.0  # center

    @staticmethod
    def _breach_tanker(ent: int, tf: Transform, side: float) -> None:
        """Add hull breaches to a tanker from a kamikaze hit."""
        from hormuz.systems.physics import BREACH_CLAMP_COUNT

        tf.hull_breaches += 3  # severe damage from kamikaze drone
        tf.breach_side = max(-1.0, min(1.0, tf.breach_side + side / BREACH_CLAMP_COUNT))

    def _kill(self, ent: int) -> None:
        health = esper.component_for_entity(ent, Health)
        health.hp = 0

        # Remove control components during respawn
        if esper.has_component(ent, BotControl):
            esper.remove_component(ent, BotControl)
        if esper.has_component(ent, PlayerControl):
            esper.remove_component(ent, PlayerControl)

        # Add respawn timer
        if not esper.has_component(ent, RespawnTimer):
            esper.add_component(ent, RespawnTimer(remaining=3.0))
