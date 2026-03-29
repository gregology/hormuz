"""Tests for bot AI processor."""


import esper
import pytest

from hormuz.components import BotControl, Faction, Health, Transform, VehiclePhysics
from hormuz.systems.bot_ai import steer_toward


class TestSteerToward:
    def test_target_to_the_right_returns_positive_rudder(self):
        tf = Transform(x=0, y=0, heading=0)  # facing east
        # Target is south-east (positive rudder to turn clockwise)
        rudder = steer_toward(tf, 100, 100)
        assert rudder > 0

    def test_target_to_the_left_returns_negative_rudder(self):
        tf = Transform(x=0, y=0, heading=0)  # facing east
        # Target is north-east (negative rudder to turn counter-clockwise)
        rudder = steer_toward(tf, 100, -100)
        assert rudder < 0

    def test_target_straight_ahead_returns_near_zero(self):
        tf = Transform(x=0, y=0, heading=0)  # facing east
        rudder = steer_toward(tf, 100, 0)
        assert abs(rudder) < 0.01

    def test_target_behind_returns_clamped_value(self):
        tf = Transform(x=0, y=0, heading=0)  # facing east
        rudder = steer_toward(tf, -100, 0)  # target is behind (west)
        assert abs(rudder) == pytest.approx(1.0, abs=0.01)

    def test_wraps_around_2pi_boundary(self):
        # Heading=0.1 (just past east), target at heading ~= 2pi-0.1 (~6.18)
        # Shortest arc is CCW (0.2 rad) rather than CW (6.08 rad)
        tf = Transform(x=0, y=0, heading=0.1)
        rudder = steer_toward(tf, 995, -100)  # atan2 ≈ -0.1
        assert rudder < 0  # should turn CCW (negative)


class TestTankerAIWaypointAdvance:
    def test_tanker_advances_waypoint_when_close(self):
        from hormuz.systems.bot_ai import LANE_OUTBOUND, BotAIProcessor

        wp = LANE_OUTBOUND[0]
        tf = Transform(x=wp[0], y=wp[1], heading=0, speed=5.0)
        phys = VehiclePhysics(
            vehicle_type="oil_tanker",
            max_speed=7.5,
            acceleration=1.0,
            drag=0.97,
            turn_rate=0.05,
            drift_factor=0.25,
            lateral_drag=0.45,
            size=220.0,
        )
        bot = BotControl("tanker_transit", waypoint_index=0)
        esper.create_entity(tf, phys, bot, Faction("civilian"), Health(100, 100))
        proc = BotAIProcessor()
        esper.add_processor(proc)

        esper.process(dt=0.05)

        assert bot.waypoint_index == 1
