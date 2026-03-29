"""Collision processor — vehicle-vehicle circle collision resolution.

Port of client/src/vehicles/collision.ts resolveVehicleCollisions().
Terrain collision is skipped for MVP (bots follow waypoints in open water).
"""

import math

import esper

from hormuz.components import Collidable, Health, Transform, VehiclePhysics

MIN_COLLISION_RADIUS = 4.0


class CollisionProcessor(esper.Processor):
    def process(self, dt: float = 0.05) -> None:
        entities = [
            (ent, tf, phys, col)
            for ent, (tf, phys, col, health) in esper.get_components(
                Transform, VehiclePhysics, Collidable, Health
            )
            if health.hp > 0
        ]

        for i in range(len(entities)):
            e_a, tf_a, phys_a, col_a = entities[i]
            for j in range(i + 1, len(entities)):
                e_b, tf_b, phys_b, col_b = entities[j]

                dx = tf_b.x - tf_a.x
                dy = tf_b.y - tf_a.y
                dist_sq = dx * dx + dy * dy

                ra = max(phys_a.size * 0.4, MIN_COLLISION_RADIUS)
                rb = max(phys_b.size * 0.4, MIN_COLLISION_RADIUS)
                min_dist = ra + rb

                if dist_sq >= min_dist * min_dist or dist_sq == 0:
                    continue

                dist = math.sqrt(dist_sq)
                overlap = min_dist - dist
                nx = dx / dist
                ny = dy / dist

                # Mass-weighted separation
                total_size = phys_a.size + phys_b.size
                push_a = overlap * (phys_b.size / total_size)
                push_b = overlap * (phys_a.size / total_size)

                tf_a.x -= nx * push_a
                tf_a.y -= ny * push_a
                tf_b.x += nx * push_b
                tf_b.y += ny * push_b

                # Speed damping — lighter vehicle loses more speed
                size_ratio = min(phys_a.size, phys_b.size) / max(phys_a.size, phys_b.size)
                damp_a = (0.3 + size_ratio * 0.55) if phys_a.size <= phys_b.size else 0.85
                damp_b = (0.3 + size_ratio * 0.55) if phys_b.size <= phys_a.size else 0.85

                tf_a.speed *= damp_a
                tf_b.speed *= damp_b
                tf_a.drift *= damp_a
                tf_b.drift *= damp_b
