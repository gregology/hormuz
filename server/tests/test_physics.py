"""Tests for the physics processor — validates the Python port of updateVehicle()."""


import esper
import pytest

from hormuz.components import BotControl, Transform, VehiclePhysics
from hormuz.systems.physics import PhysicsProcessor


def _make_tanker_physics() -> VehiclePhysics:
    return VehiclePhysics(
        vehicle_type="oil_tanker",
        max_speed=7.5,
        acceleration=1.0,
        drag=0.97,
        turn_rate=0.05,
        drift_factor=0.25,
        lateral_drag=0.45,
        min_turn_fraction=0.0,
        cruise_speed=0.0,
        airborne=False,
        size=220.0,
    )


def _make_shahed_physics() -> VehiclePhysics:
    return VehiclePhysics(
        vehicle_type="shahed",
        max_speed=40.0,
        acceleration=5.0,
        drag=0.95,
        turn_rate=0.5,
        drift_factor=0.02,
        lateral_drag=0.1,
        min_turn_fraction=1.0,
        cruise_speed=34.0,
        airborne=True,
        size=4.0,
    )


class TestCruiseSpeed:
    def test_shahed_always_moves_at_cruise_speed(self):
        tf = Transform(x=0, y=0, heading=0)
        phys = _make_shahed_physics()
        bot = BotControl("shahed_intercept", throttle=0.0, rudder=0.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        esper.process(dt=0.05)

        assert tf.speed == pytest.approx(34.0)
        assert tf.x > 0  # moved east (heading=0)

    def test_shahed_cruise_ignores_throttle_value(self):
        tf = Transform(x=0, y=0, heading=0)
        phys = _make_shahed_physics()
        bot = BotControl("shahed_intercept", throttle=-1.0, rudder=0.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        esper.process(dt=0.05)

        assert tf.speed == pytest.approx(34.0)


class TestThrottle:
    def test_tanker_accelerates_with_forward_throttle(self):
        tf = Transform(x=0, y=0, heading=0, speed=0)
        phys = _make_tanker_physics()
        bot = BotControl("tanker_transit", throttle=1.0, rudder=0.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        esper.process(dt=0.05)

        assert tf.speed > 0

    def test_reverse_throttle_is_weaker(self):
        tf_fwd = Transform(x=0, y=0, heading=0, speed=0)
        phys_fwd = _make_tanker_physics()
        bot_fwd = BotControl("tanker_transit", throttle=1.0, rudder=0.0)
        esper.create_entity(tf_fwd, phys_fwd, bot_fwd)

        tf_rev = Transform(x=100, y=0, heading=0, speed=0)
        phys_rev = _make_tanker_physics()
        bot_rev = BotControl("tanker_transit", throttle=-1.0, rudder=0.0)
        esper.create_entity(tf_rev, phys_rev, bot_rev)

        proc = PhysicsProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        assert abs(tf_fwd.speed) > abs(tf_rev.speed)


class TestDrag:
    def test_speed_decays_without_input(self):
        tf = Transform(x=0, y=0, heading=0, speed=5.0)
        phys = _make_tanker_physics()
        bot = BotControl("tanker_transit", throttle=0.0, rudder=0.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        esper.process(dt=0.05)

        assert tf.speed < 5.0
        assert tf.speed > 0


class TestMaxSpeed:
    def test_speed_clamped_to_max(self):
        tf = Transform(x=0, y=0, heading=0, speed=7.5)
        phys = _make_tanker_physics()
        bot = BotControl("tanker_transit", throttle=1.0, rudder=0.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        # Run many ticks
        for _ in range(1000):
            esper.process(dt=0.05)

        assert tf.speed <= phys.max_speed


class TestSteering:
    def test_tanker_at_speed_turns_with_rudder(self):
        tf = Transform(x=0, y=0, heading=0, speed=5.0)
        phys = _make_tanker_physics()
        bot = BotControl("tanker_transit", throttle=1.0, rudder=1.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        esper.process(dt=0.05)

        assert tf.heading > 0

    def test_tanker_at_zero_speed_cannot_turn(self):
        tf = Transform(x=0, y=0, heading=0, speed=0)
        phys = _make_tanker_physics()
        bot = BotControl("tanker_transit", throttle=0.0, rudder=1.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        esper.process(dt=0.05)

        assert tf.heading == 0.0

    def test_shahed_can_steer_at_any_speed(self):
        """Shahed has minTurnFraction=1.0 so it can always steer."""
        tf = Transform(x=0, y=0, heading=0, speed=0)
        phys = _make_shahed_physics()
        bot = BotControl("shahed_intercept", throttle=0.0, rudder=1.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        esper.process(dt=0.05)

        assert tf.heading > 0
