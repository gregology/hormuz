"""Tests for the physics processor — validates the Python port of updateVehicle()."""


import math

import esper
import pytest

from hormuz.components import BotControl, Health, Transform, VehiclePhysics
from hormuz.systems.physics import PhysicsProcessor


def _make_tanker_physics() -> VehiclePhysics:
    return VehiclePhysics(
        vehicle_type="oil_tanker",
        max_speed=15.0,
        acceleration=2.0,
        drag=0.97,
        turn_rate=0.0,
        drift_factor=0.0,
        lateral_drag=0.45,
        min_turn_fraction=0.0,
        cruise_speed=0.0,
        airborne=False,
        size=220.0,
        angular_drag=0.30,
        mass=2200.0,
        engine_power=4400.0,
        drag_coefficient=4400.0 / (15.0 * 15.0),
        propeller_offset=-0.4,
        rudder_max_angle=0.6,
        moment_of_inertia=3600000.0,
        rudder_flow_coefficient=0.5 * 4400.0 / (15.0 * 15.0),
    )


def _make_shahed_physics() -> VehiclePhysics:
    return VehiclePhysics(
        vehicle_type="shahed",
        max_speed=80.0,
        acceleration=10.0,
        drag=0.95,
        turn_rate=0.5,
        drift_factor=0.02,
        lateral_drag=0.1,
        min_turn_fraction=1.0,
        cruise_speed=68.0,
        airborne=True,
        size=4.0,
        angular_drag=0.10,
        mass=40.0,
        engine_power=400.0,
        drag_coefficient=400.0 / (80.0 * 80.0),
        propeller_offset=0.0,
        rudder_max_angle=0.0,
        moment_of_inertia=0.0,
        rudder_flow_coefficient=0.0,
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

        assert tf.speed == pytest.approx(68.0)
        assert tf.x > 0  # moved east (heading=0)

    def test_shahed_cruise_ignores_throttle_value(self):
        tf = Transform(x=0, y=0, heading=0)
        phys = _make_shahed_physics()
        bot = BotControl("shahed_intercept", throttle=-1.0, rudder=0.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        esper.process(dt=0.05)

        assert tf.speed == pytest.approx(68.0)


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


class TestEquilibriumSpeed:
    def test_speed_converges_to_equilibrium(self):
        tf = Transform(x=0, y=0, heading=0, speed=0)
        phys = _make_tanker_physics()
        bot = BotControl("tanker_transit", throttle=1.0, rudder=0.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        eq_speed = math.sqrt(phys.engine_power / phys.drag_coefficient)
        for _ in range(2000):
            esper.process(dt=0.05)

        assert tf.speed > eq_speed * 0.95
        assert tf.speed <= eq_speed * 1.05


class TestSteering:
    def test_tanker_with_throttle_and_rudder_turns(self):
        tf = Transform(x=0, y=0, heading=0, speed=0)
        phys = _make_tanker_physics()
        bot = BotControl("tanker_transit", throttle=1.0, rudder=1.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        for _ in range(10):
            esper.process(dt=0.05)

        assert tf.heading > 0

    def test_tanker_without_throttle_does_not_turn(self):
        tf = Transform(x=0, y=0, heading=0, speed=0)
        phys = _make_tanker_physics()
        bot = BotControl("tanker_transit", throttle=0.0, rudder=1.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        esper.process(dt=0.05)

        assert tf.heading == 0.0

    def test_tanker_at_speed_steers_via_rudder_flow(self):
        """Tanker with forward speed but no throttle can steer via water flow over rudder."""
        tf = Transform(x=0, y=0, heading=0, speed=10.0)
        phys = _make_tanker_physics()
        bot = BotControl("tanker_transit", throttle=0.0, rudder=1.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        for _ in range(10):
            esper.process(dt=0.05)

        assert tf.heading > 0

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


class TestFlooding:
    def test_breach_causes_flooding(self):
        tf = Transform(x=0, y=0, heading=0, speed=5.0, hull_breaches=1)
        phys = _make_tanker_physics()
        bot = BotControl("tanker_transit", throttle=1.0, rudder=0.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        for _ in range(60):
            esper.process(dt=0.05)

        assert tf.flood_level > 0

    def test_port_breach_produces_negative_list(self):
        tf = Transform(x=0, y=0, heading=0, hull_breaches=1, breach_side=-1.0)
        phys = _make_tanker_physics()
        bot = BotControl("tanker_transit", throttle=0.0, rudder=0.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        for _ in range(120):
            esper.process(dt=0.05)

        assert tf.list_angle < 0

    def test_airborne_unaffected_by_breaches(self):
        tf = Transform(x=0, y=0, heading=0, hull_breaches=3)
        phys = _make_shahed_physics()
        bot = BotControl("shahed_intercept", throttle=1.0, rudder=0.0)
        esper.create_entity(tf, phys, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        for _ in range(600):
            esper.process(dt=0.05)

        assert tf.flood_level == 0.0

    def test_flooding_kills_entity(self):
        tf = Transform(x=0, y=0, heading=0, hull_breaches=5)
        phys = _make_tanker_physics()
        health = Health(hp=100, max_hp=100)
        bot = BotControl("tanker_transit", throttle=0.0, rudder=0.0)
        esper.create_entity(tf, phys, health, bot)
        proc = PhysicsProcessor()
        esper.add_processor(proc)

        for _ in range(2000):
            esper.process(dt=0.05)

        assert tf.flood_level >= 1.0
        assert health.hp == 0
