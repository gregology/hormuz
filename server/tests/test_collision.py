"""Tests for SAT-based polygon collision processor."""

import math

import esper

from hormuz.components import Collidable, Health, Transform, VehiclePhysics
from hormuz.systems.collision import COLLISION_POLYGONS, CollisionProcessor


def _make_phys(vehicle_type: str = "oil_tanker", size: float = 220.0) -> VehiclePhysics:
    return VehiclePhysics(
        vehicle_type=vehicle_type,
        max_speed=10,
        acceleration=1,
        drag=0.95,
        turn_rate=0.5,
        drift_factor=0.02,
        lateral_drag=0.1,
        size=size,
    )


def _make_collidable(vehicle_type: str = "oil_tanker") -> Collidable:
    return Collidable(COLLISION_POLYGONS[vehicle_type])


def _dist(tf_a: Transform, tf_b: Transform) -> float:
    return math.sqrt((tf_b.x - tf_a.x) ** 2 + (tf_b.y - tf_a.y) ** 2)


class TestVehicleCollision:
    def test_overlapping_vehicles_are_pushed_apart(self):
        tf_a = Transform(x=0, y=0, speed=5.0)
        tf_b = Transform(x=5, y=0, speed=5.0)
        esper.create_entity(
            tf_a, _make_phys("oil_tanker", 20), _make_collidable("oil_tanker"), Health(100, 100)
        )
        esper.create_entity(
            tf_b, _make_phys("oil_tanker", 20), _make_collidable("oil_tanker"), Health(100, 100)
        )
        esper.add_processor(CollisionProcessor())

        dist_before = _dist(tf_a, tf_b)
        esper.process(dt=0.05)
        dist_after = _dist(tf_a, tf_b)

        assert dist_after > dist_before

    def test_distant_vehicles_unaffected(self):
        tf_a = Transform(x=0, y=0, speed=5.0)
        tf_b = Transform(x=1000, y=0, speed=5.0)
        esper.create_entity(
            tf_a, _make_phys("oil_tanker", 20), _make_collidable("oil_tanker"), Health(100, 100)
        )
        esper.create_entity(
            tf_b, _make_phys("oil_tanker", 20), _make_collidable("oil_tanker"), Health(100, 100)
        )
        esper.add_processor(CollisionProcessor())

        esper.process(dt=0.05)

        assert tf_a.speed == 5.0
        assert tf_b.speed == 5.0

    def test_small_vehicle_deflected_by_large(self):
        # Shahed approaches tanker head-on
        tf_small = Transform(x=-100, y=0, heading=0, speed=10.0)
        tf_big = Transform(x=0, y=0, heading=math.pi, speed=0.0)
        esper.create_entity(
            tf_small, _make_phys("shahed", 4), _make_collidable("shahed"), Health(10, 10)
        )
        esper.create_entity(
            tf_big, _make_phys("oil_tanker", 220), _make_collidable("oil_tanker"), Health(100, 100)
        )
        esper.add_processor(CollisionProcessor())

        esper.process(dt=0.05)

        # Small vehicle should be deflected
        deflected = (
            abs(tf_small.speed) != 10.0
            or abs(tf_small.drift) > 0
            or _dist(tf_small, tf_big) > 100
        )
        assert deflected

    def test_perpendicular_hit_produces_angular_velocity(self):
        # Frigate heading east hits tanker heading south at its bow
        tf_a = Transform(x=0, y=0, heading=0, speed=10.0)
        tf_b = Transform(x=60, y=-60, heading=1.5708, speed=7.0)
        esper.create_entity(
            tf_a, _make_phys("frigate", 100), _make_collidable("frigate"), Health(300, 300)
        )
        esper.create_entity(
            tf_b, _make_phys("oil_tanker", 220), _make_collidable("oil_tanker"), Health(100, 100)
        )
        esper.add_processor(CollisionProcessor())

        esper.process(dt=0.05)

        has_rotation = abs(tf_a.angular_velocity) > 0.001 or abs(tf_b.angular_velocity) > 0.001
        assert has_rotation
