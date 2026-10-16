"""Tests for bot AI — end-to-end through BotAIProcessor and the shared Lua VM.

Behavior logic lives in shared/ai/*.lua; these tests verify the server-side
integration: world-view building, control application, scent forwarding, and
behavior outcomes on esper state, and group membership surviving a VM rebuild.
Lua internals are covered by the client Vitest suite (client/src/ai/lua-host.test.ts,
client/src/ai/groups.test.ts).
"""

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


def _make_tanker(x, y, heading=0.0, speed=5.0, destination="oman", waypoint_index=1):
    """A bot tanker, by default under way (past the start of its route)."""
    return esper.create_entity(
        Transform(x=x, y=y, heading=heading, speed=speed),
        VehiclePhysics(vehicle_type="oil_tanker", max_speed=15, size=220.0),
        BotControl("tanker_transit", waypoint_index=waypoint_index),
        Faction("civilian"),
        Health(100, 100),
        CargoState(loaded=True, destination=destination),
    )


def _make_anchored_tankers():
    """Tankers waiting at the Gulf end of the outbound route, as they spawn there."""
    return [
        _make_tanker(x, y, heading=5.5, speed=0.0, waypoint_index=0)
        for x, y in ((74000.0, 53800.0), (74700.0, 53300.0), (73400.0, 54300.0))
    ]


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
    def test_tanker_under_way_advances_waypoint_when_close(self):
        from hormuz.map_data import LANE_ALT_OUTBOUND

        wp = LANE_ALT_OUTBOUND[1]
        ent = _make_tanker(x=wp[0] + 100, y=wp[1], waypoint_index=1)
        _run_ai()

        assert esper.component_for_entity(ent, BotControl).waypoint_index == 2


class TestConvoys:
    def test_tankers_at_the_start_of_their_route_wait_for_an_escort(self):
        tankers = _make_anchored_tankers()
        _run_ai()

        bots = [esper.component_for_entity(t, BotControl) for t in tankers]
        assert all(b.throttle == 0.0 for b in bots)
        assert bots[0].group != 0
        assert {b.group for b in bots} == {bots[0].group}

    def test_frigate_is_assigned_to_a_waiting_convoy(self):
        tankers = _make_anchored_tankers()
        frigate = _make_frigate(x=77880.0, y=51086.0)
        _run_ai()

        convoy = esper.component_for_entity(tankers[0], BotControl).group
        bot = esper.component_for_entity(frigate, BotControl)
        assert bot.group == convoy
        assert bot.throttle == pytest.approx(1.0)  # far from station: close at full speed

    def test_group_membership_survives_an_ai_vm_rebuild(self):
        proc = BotAIProcessor()
        esper.add_processor(proc)
        # Use up group id 1, so a VM that lost track would hand out 1 again.
        dummy = _make_tanker(x=_WX, y=_WY)
        esper.process(dt=0.05)
        esper.delete_entity(dummy, immediate=True)
        tankers = _make_anchored_tankers()
        frigate = _make_frigate(x=77880.0, y=51086.0)
        for _ in range(20):
            esper.process(dt=0.05)
        before = {e: esper.component_for_entity(e, BotControl).group for e in [*tankers, frigate]}
        assert set(before.values()) == {2}

        reset_bridge()
        esper.process(dt=0.05)

        after = {e: esper.component_for_entity(e, BotControl).group for e in [*tankers, frigate]}
        assert after == before


class TestTankerDangerAvoidance:
    def test_tanker_steers_away_from_danger(self):
        ent = _make_tanker(x=_WX, y=_WY, heading=0.0, speed=10.0)
        get_bridge().emit_scent(_WX, _WY + 500)  # danger to the south/right

        _run_ai()

        bot = esper.component_for_entity(ent, BotControl)
        rudder_with_danger = bot.rudder

        # Reset and run without danger
        reset_bridge()
        bot2 = BotControl("tanker_transit", waypoint_index=1)
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


class TestFrigateDangerAttraction:
    def test_spare_frigate_rushes_toward_danger(self):
        get_bridge().emit_scent(_WX + 5000, _WY)  # danger to the east
        ent = _make_frigate(x=_WX, y=_WY, heading=0.0)
        bot = esper.component_for_entity(ent, BotControl)

        _run_ai()

        assert bot.throttle == pytest.approx(1.0)


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
