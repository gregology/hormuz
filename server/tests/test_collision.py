"""Tests for collision processor."""

import esper

from hormuz.components import Collidable, Health, Transform, VehiclePhysics
from hormuz.systems.collision import CollisionProcessor


def _make_phys(size: float) -> VehiclePhysics:
    return VehiclePhysics(
        vehicle_type="test",
        max_speed=10,
        acceleration=1,
        drag=0.95,
        turn_rate=0.5,
        drift_factor=0.02,
        lateral_drag=0.1,
        size=size,
    )


class TestVehicleCollision:
    def test_overlapping_vehicles_are_pushed_apart(self):
        tf_a = Transform(x=0, y=0, speed=5.0)
        tf_b = Transform(x=5, y=0, speed=5.0)
        # size=20 -> radius=8, min_dist=16, actual dist=5 -> overlap
        esper.create_entity(tf_a, _make_phys(20), Collidable(8), Health(100, 100))
        esper.create_entity(tf_b, _make_phys(20), Collidable(8), Health(100, 100))
        esper.add_processor(CollisionProcessor())

        esper.process(dt=0.05)

        # They should be further apart now
        assert tf_b.x - tf_a.x > 5

    def test_distant_vehicles_unaffected(self):
        tf_a = Transform(x=0, y=0, speed=5.0)
        tf_b = Transform(x=1000, y=0, speed=5.0)
        esper.create_entity(tf_a, _make_phys(20), Collidable(8), Health(100, 100))
        esper.create_entity(tf_b, _make_phys(20), Collidable(8), Health(100, 100))
        esper.add_processor(CollisionProcessor())

        esper.process(dt=0.05)

        assert tf_a.speed == 5.0
        assert tf_b.speed == 5.0

    def test_lighter_vehicle_loses_more_speed(self):
        tf_small = Transform(x=0, y=0, speed=10.0)
        tf_big = Transform(x=5, y=0, speed=10.0)
        # Small vehicle size=4, big vehicle size=220
        esper.create_entity(tf_small, _make_phys(4), Collidable(4), Health(10, 10))
        esper.create_entity(tf_big, _make_phys(220), Collidable(88), Health(100, 100))
        esper.add_processor(CollisionProcessor())

        esper.process(dt=0.05)

        assert tf_small.speed < tf_big.speed
