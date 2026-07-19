"""Tests for bot AI — end-to-end through BotAIProcessor and the shared Lua VM.

Behavior logic lives in shared/ai/*.lua; these tests verify the server-side
integration: world-view building, control application, scent forwarding, and
behavior outcomes on esper state. Lua internals are covered by the client
Vitest suite (client/src/ai/lua-host.test.ts).
"""

import math

import esper
import pytest

from hormuz.components import (
    BotControl,
    CargoState,
    Faction,
    Health,
    Transform,
    VehiclePhysics,
)
from hormuz.systems.ai_bridge import get_bridge, reset_bridge
from hormuz.systems.bot_ai import BotAIProcessor

TANKER_BRAKE_RANGE = 400.0  # mirrors shared/ai/config.lua tanker.brake_range
DRONE_REPEL_RANGE_SHAHED = 1000.0  # mirrors config shahed.repel_range

# Water coordinates on the shipping lane (avoids land avoidance interference)
_WX = 60000.0
_WY = 43000.0


@pytest.fixture(autouse=True)
def _fresh_ai_bridge():
    """Fresh Lua VM per test — clean danger scents and default config."""
    reset_bridge()
    yield
    reset_bridge()


def _run_ai(dt: float = 0.05) -> None:
    proc = BotAIProcessor()
    esper.add_processor(proc)
    esper.process(dt=dt)


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


def _make_shahed(x, y, heading=0.0, speed=80.0):
    return esper.create_entity(
        Transform(x=x, y=y, heading=heading, speed=speed),
        VehiclePhysics(vehicle_type="shahed", max_speed=80, size=4.0, airborne=True),
        BotControl("shahed_intercept"),
        Faction("iran"),
        Health(10, 10),
    )


def _make_quadcopter(x, y, heading=0.0, speed=30.0):
    return esper.create_entity(
        Transform(x=x, y=y, heading=heading, speed=speed),
        VehiclePhysics(vehicle_type="quadcopter", max_speed=30, size=2.0, airborne=True),
        BotControl("quadcopter_intercept"),
        Faction("iran"),
        Health(5, 5),
    )


class TestTankerAIWaypointAdvance:
    def test_tanker_advances_waypoint_when_close(self):
        from hormuz.map_data import LANE_ALT_OUTBOUND

        wp = LANE_ALT_OUTBOUND[0]
        bot = BotControl("tanker_transit", waypoint_index=0)
        esper.create_entity(
            Transform(x=wp[0], y=wp[1], heading=0, speed=5.0),
            VehiclePhysics(vehicle_type="oil_tanker", max_speed=7.5, size=220.0),
            bot,
            Faction("civilian"),
            Health(100, 100),
        )
        _run_ai()

        assert bot.waypoint_index == 1


class TestTankerBraking:
    def test_tanker_brakes_for_tanker_ahead(self):
        _make_tanker(x=_WX + 200, y=_WY, heading=0.0, speed=5.0)
        ent = _make_tanker(x=_WX, y=_WY, heading=0.0, speed=10.0)
        bot = esper.component_for_entity(ent, BotControl)

        _run_ai()

        assert bot.throttle < 1.0

    def test_tanker_does_not_brake_for_tanker_behind(self):
        _make_tanker(x=_WX - 200, y=_WY, heading=0.0, speed=5.0)
        ent = _make_tanker(x=_WX, y=_WY, heading=0.0, speed=10.0)
        bot = esper.component_for_entity(ent, BotControl)

        _run_ai()

        assert bot.throttle == pytest.approx(1.0)

    def test_tanker_does_not_brake_for_distant_tanker(self):
        _make_tanker(x=_WX + TANKER_BRAKE_RANGE + 500, y=_WY, heading=0.0)
        ent = _make_tanker(x=_WX, y=_WY, heading=0.0, speed=10.0)
        bot = esper.component_for_entity(ent, BotControl)

        _run_ai()

        assert bot.throttle == pytest.approx(1.0)


class TestTankerDangerAvoidance:
    def test_tanker_steers_away_from_danger(self):
        ent = _make_tanker(x=_WX, y=_WY, heading=0.0, speed=10.0)
        get_bridge().emit_scent(_WX, _WY + 500)  # danger to the south/right

        _run_ai()

        bot = esper.component_for_entity(ent, BotControl)
        rudder_with_danger = bot.rudder

        # Reset and run without danger
        reset_bridge()
        bot2 = BotControl("tanker_transit")
        esper.create_entity(
            Transform(x=_WX, y=_WY, heading=0.0, speed=10.0),
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


class TestFrigateEscort:
    def test_frigate_steers_toward_assigned_tanker(self):
        _make_tanker(x=_WX + 2000, y=_WY, heading=0.0)
        ent = _make_frigate(x=_WX, y=_WY, heading=-math.pi / 2)  # facing north
        bot = esper.component_for_entity(ent, BotControl)

        _run_ai()

        # Should steer toward tanker (positive rudder to turn right toward east)
        assert bot.rudder > 0
        assert bot.target_entity != 0

    def test_frigates_distribute_across_tankers(self):
        t1 = _make_tanker(x=_WX + 3000, y=_WY - 500, heading=0.0)
        t2 = _make_tanker(x=_WX + 3000, y=_WY + 500, heading=0.0)
        f1 = _make_frigate(x=_WX, y=_WY, heading=0.0)
        f2 = _make_frigate(x=_WX, y=_WY, heading=0.0)

        _run_ai()

        bot1 = esper.component_for_entity(f1, BotControl)
        bot2 = esper.component_for_entity(f2, BotControl)
        assert bot1.target_entity != bot2.target_entity
        assert {bot1.target_entity, bot2.target_entity} == {t1, t2}

    def test_frigate_reaches_distant_tanker(self):
        t = _make_tanker(x=_WX + 20000, y=_WY, heading=0.0)
        ent = _make_frigate(x=_WX, y=_WY, heading=0.0)
        bot = esper.component_for_entity(ent, BotControl)

        _run_ai()

        assert bot.target_entity == t
        assert bot.throttle == pytest.approx(1.0)  # full speed to close distance


class TestFrigateDangerAttraction:
    def test_frigate_rushes_toward_danger(self):
        get_bridge().emit_scent(_WX + 5000, _WY)  # danger to the east
        ent = _make_frigate(x=_WX, y=_WY, heading=0.0)
        bot = esper.component_for_entity(ent, BotControl)

        _run_ai()

        assert bot.throttle == pytest.approx(1.0)


class TestFrigateRepulsion:
    def test_frigates_repel_each_other(self):
        ent1 = _make_frigate(x=_WX, y=_WY, heading=0.0)
        ent2 = _make_frigate(x=_WX, y=_WY + 500, heading=0.0)

        # Add a tanker nearby so presence attraction is active
        _make_tanker(x=_WX + 1000, y=_WY + 250, heading=0.0)

        _run_ai()

        bot1 = esper.component_for_entity(ent1, BotControl)
        bot2 = esper.component_for_entity(ent2, BotControl)

        # Frigates at different y positions should get different rudder from repulsion
        assert bot1.rudder != pytest.approx(bot2.rudder, abs=0.01)


class TestDroneTargetPressure:
    def test_two_shaheds_pick_different_tankers(self):
        t1 = _make_tanker(x=_WX + 3000, y=_WY - 500, heading=0.0)
        t2 = _make_tanker(x=_WX + 3000, y=_WY + 500, heading=0.0)
        s1 = _make_shahed(x=_WX, y=_WY, heading=0.0)
        s2 = _make_shahed(x=_WX, y=_WY, heading=0.0)

        proc = BotAIProcessor()
        esper.add_processor(proc)
        # Run two ticks — first tick both may pick same target,
        # second tick pressure scoring redistributes
        esper.process(dt=0.05)
        esper.process(dt=0.05)

        bot1 = esper.component_for_entity(s1, BotControl)
        bot2 = esper.component_for_entity(s2, BotControl)
        assert bot1.target_entity != bot2.target_entity
        assert {bot1.target_entity, bot2.target_entity} == {t1, t2}

    def test_lone_shahed_picks_nearest_tanker(self):
        _make_tanker(x=_WX + 5000, y=_WY, heading=0.0)  # far
        near = _make_tanker(x=_WX + 1000, y=_WY, heading=0.0)  # near
        s = _make_shahed(x=_WX, y=_WY, heading=0.0)

        _run_ai()

        bot = esper.component_for_entity(s, BotControl)
        assert bot.target_entity == near

    def test_shahed_drops_dead_target(self):
        t = _make_tanker(x=_WX + 2000, y=_WY, heading=0.0)
        s = _make_shahed(x=_WX, y=_WY, heading=0.0)

        proc = BotAIProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        bot = esper.component_for_entity(s, BotControl)
        assert bot.target_entity == t

        # Kill the tanker
        esper.component_for_entity(t, Health).hp = 0
        esper.process(dt=0.05)
        assert bot.target_entity == 0  # cleared, no other targets

    def test_quadcopters_spread_across_targets(self):
        t1 = _make_tanker(x=_WX + 2000, y=_WY - 300, heading=0.0)
        t2 = _make_frigate(x=_WX + 2000, y=_WY + 300, heading=0.0)
        q1 = _make_quadcopter(x=_WX, y=_WY, heading=0.0)
        q2 = _make_quadcopter(x=_WX, y=_WY, heading=0.0)

        proc = BotAIProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)
        esper.process(dt=0.05)

        bot1 = esper.component_for_entity(q1, BotControl)
        bot2 = esper.component_for_entity(q2, BotControl)
        assert bot1.target_entity != bot2.target_entity
        assert {bot1.target_entity, bot2.target_entity} == {t1, t2}


class TestDroneRepulsion:
    def test_nearby_shaheds_get_different_rudder(self):
        _make_tanker(x=_WX + 3000, y=_WY, heading=0.0)
        s1 = _make_shahed(x=_WX, y=_WY - 100, heading=0.0)
        s2 = _make_shahed(x=_WX, y=_WY + 100, heading=0.0)

        _run_ai()

        bot1 = esper.component_for_entity(s1, BotControl)
        bot2 = esper.component_for_entity(s2, BotControl)
        # Repulsion should push them apart: one turns left, other turns right
        assert bot1.rudder < bot2.rudder

    def test_distant_shaheds_unaffected_by_repulsion(self):
        _make_tanker(x=_WX + 3000, y=_WY, heading=0.0)
        far_offset = DRONE_REPEL_RANGE_SHAHED + 500
        s1 = _make_shahed(x=_WX, y=_WY - far_offset, heading=0.0)
        s2 = _make_shahed(x=_WX, y=_WY + far_offset, heading=0.0)

        _run_ai()

        bot1 = esper.component_for_entity(s1, BotControl)
        bot2 = esper.component_for_entity(s2, BotControl)
        # Equidistant above/below the target: symmetric rudder
        assert bot1.rudder == pytest.approx(-bot2.rudder, abs=0.05)


class TestAutopilotWaypointFollow:
    def test_waypoint_follow_returns_rudder_and_advances(self):
        from hormuz.map_data import LANE_ALT_OUTBOUND

        wp = LANE_ALT_OUTBOUND[0]
        rudder, new_index = get_bridge().waypoint_follow(wp[0], wp[1], 0.0, 0, "oman")
        assert new_index == 1
        # Next waypoint is south-east of here — positive rudder from heading 0
        assert isinstance(rudder, float)
