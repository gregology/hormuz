"""Tests for bot AI processor."""

import math

import esper
import pytest

from hormuz.components import BotControl, CargoState, Faction, Health, Transform, VehiclePhysics
from hormuz.systems.bot_ai import (
    FRIGATE_PRESENCE_RANGE,
    TANKER_BRAKE_RANGE,
    BotAIProcessor,
    steer_toward,
)
from hormuz.systems.danger_scent import clear_all, emit_danger_scent

# Water coordinates on the shipping lane (avoids land avoidance interference)
_WX = 60000.0
_WY = 43000.0


@pytest.fixture(autouse=True)
def _clear_danger_scents():
    """Clear danger scents between tests."""
    clear_all()
    yield
    clear_all()


def _make_tanker(x, y, heading=0.0, speed=5.0, destination="oman"):
    return esper.create_entity(
        Transform(x=x, y=y, heading=heading, speed=speed),
        VehiclePhysics(vehicle_type="oil_tanker", max_speed=15, size=220.0),
        BotControl("tanker_transit"),
        Faction("civilian"),
        Health(100, 100),
        CargoState(loaded=True, destination=destination),
    )


def _make_frigate(x, y, heading=0.0, speed=0.0):
    return esper.create_entity(
        Transform(x=x, y=y, heading=heading, speed=speed),
        VehiclePhysics(vehicle_type="frigate", max_speed=25, size=100.0),
        BotControl("escort"),
        Faction("us"),
        Health(300, 300),
    )


class TestSteerToward:
    def test_target_to_the_right_returns_positive_rudder(self):
        tf = Transform(x=0, y=0, heading=0)
        rudder = steer_toward(tf, 100, 100)
        assert rudder > 0

    def test_target_to_the_left_returns_negative_rudder(self):
        tf = Transform(x=0, y=0, heading=0)
        rudder = steer_toward(tf, 100, -100)
        assert rudder < 0

    def test_target_straight_ahead_returns_near_zero(self):
        tf = Transform(x=0, y=0, heading=0)
        rudder = steer_toward(tf, 100, 0)
        assert abs(rudder) < 0.01

    def test_target_behind_returns_clamped_value(self):
        tf = Transform(x=0, y=0, heading=0)
        rudder = steer_toward(tf, -100, 0)
        assert abs(rudder) == pytest.approx(1.0, abs=0.01)

    def test_wraps_around_2pi_boundary(self):
        tf = Transform(x=0, y=0, heading=0.1)
        rudder = steer_toward(tf, 995, -100)
        assert rudder < 0


class TestTankerAIWaypointAdvance:
    def test_tanker_advances_waypoint_when_close(self):
        from hormuz.systems.bot_ai import LANE_OUTBOUND

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


class TestTankerBraking:
    def test_tanker_brakes_for_tanker_ahead(self):
        """A tanker should reduce throttle when another tanker is directly ahead."""
        _make_tanker(x=_WX + 200, y=_WY, heading=0.0, speed=5.0)
        ent = _make_tanker(x=_WX, y=_WY, heading=0.0, speed=10.0)
        bot = esper.component_for_entity(ent, BotControl)

        proc = BotAIProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        assert bot.throttle < 1.0

    def test_tanker_does_not_brake_for_tanker_behind(self):
        """A tanker should not brake for a tanker behind it."""
        _make_tanker(x=_WX - 200, y=_WY, heading=0.0, speed=5.0)
        ent = _make_tanker(x=_WX, y=_WY, heading=0.0, speed=10.0)
        bot = esper.component_for_entity(ent, BotControl)

        proc = BotAIProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        assert bot.throttle == pytest.approx(1.0)

    def test_tanker_does_not_brake_for_distant_tanker(self):
        """Tankers beyond brake range don't affect throttle."""
        _make_tanker(x=_WX + TANKER_BRAKE_RANGE + 500, y=_WY, heading=0.0)
        ent = _make_tanker(x=_WX, y=_WY, heading=0.0, speed=10.0)
        bot = esper.component_for_entity(ent, BotControl)

        proc = BotAIProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        assert bot.throttle == pytest.approx(1.0)


class TestTankerDangerAvoidance:
    def test_tanker_steers_away_from_danger(self):
        """A tanker near a danger scent should have its rudder biased away."""
        ent = _make_tanker(x=_WX, y=_WY, heading=0.0, speed=10.0)
        emit_danger_scent(_WX, _WY + 500)  # danger to the south/right

        proc = BotAIProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        bot = esper.component_for_entity(ent, BotControl)
        rudder_with_danger = bot.rudder

        # Reset and run without danger
        clear_all()
        bot2 = BotControl("tanker_transit")
        tf2 = Transform(x=_WX, y=_WY, heading=0.0, speed=10.0)
        esper.create_entity(
            tf2,
            VehiclePhysics(vehicle_type="oil_tanker", max_speed=15, size=220.0),
            bot2,
            Faction("civilian"),
            Health(100, 100),
            CargoState(loaded=True, destination="oman"),
        )
        esper.process(dt=0.05)
        rudder_without_danger = bot2.rudder

        # Danger to right should push rudder more negative (away from south)
        assert rudder_with_danger < rudder_without_danger


class TestFrigatePresenceAttraction:
    def test_frigate_steers_toward_nearby_tanker(self):
        """A frigate within presence range should steer toward the nearest tanker."""
        _make_tanker(x=_WX + 2000, y=_WY, heading=0.0)
        ent = _make_frigate(x=_WX, y=_WY, heading=-math.pi / 2)  # facing north
        bot = esper.component_for_entity(ent, BotControl)

        proc = BotAIProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        # Should steer toward tanker (positive rudder to turn right toward east)
        assert bot.rudder > 0

    def test_frigate_ignores_tanker_beyond_presence_range(self):
        """A frigate should not be attracted to a tanker beyond presence range."""
        _make_tanker(x=_WX + FRIGATE_PRESENCE_RANGE + 1000, y=_WY, heading=0.0)
        ent = _make_frigate(x=_WX, y=_WY, heading=0.0)
        bot = esper.component_for_entity(ent, BotControl)

        proc = BotAIProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        # No tanker attraction — should be in patrol mode
        assert bot.throttle == pytest.approx(0.7)


class TestFrigateDangerAttraction:
    def test_frigate_rushes_toward_danger(self):
        """A frigate should steer toward a nearby danger scent."""
        emit_danger_scent(_WX + 5000, _WY)  # Danger to the east
        ent = _make_frigate(x=_WX, y=_WY, heading=0.0)
        bot = esper.component_for_entity(ent, BotControl)

        proc = BotAIProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        # Should go full throttle toward danger
        assert bot.throttle == pytest.approx(1.0)


class TestFrigateRepulsion:
    def test_frigates_repel_each_other(self):
        """Two nearby frigates should steer apart."""
        ent1 = _make_frigate(x=_WX, y=_WY, heading=0.0)
        ent2 = _make_frigate(x=_WX, y=_WY + 500, heading=0.0)

        # Add a tanker nearby so presence attraction is active
        _make_tanker(x=_WX + 1000, y=_WY + 250, heading=0.0)

        proc = BotAIProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        bot1 = esper.component_for_entity(ent1, BotControl)
        bot2 = esper.component_for_entity(ent2, BotControl)

        # Frigates at different y positions should get different rudder from repulsion
        assert bot1.rudder != pytest.approx(bot2.rudder, abs=0.01)
