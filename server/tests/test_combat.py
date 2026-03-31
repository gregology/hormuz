"""Tests for combat processor."""

import esper

from hormuz.components import (
    BotControl,
    Collidable,
    Faction,
    Health,
    RespawnTimer,
    Transform,
    VehiclePhysics,
)
from hormuz.systems.collision import COLLISION_POLYGONS
from hormuz.systems.combat import CombatProcessor


def _make_shahed(x: float, y: float) -> tuple:
    return (
        Transform(x=x, y=y, heading=0, speed=34),
        VehiclePhysics(
            vehicle_type="shahed",
            max_speed=40,
            acceleration=5,
            drag=0.95,
            turn_rate=0.5,
            drift_factor=0.02,
            lateral_drag=0.1,
            min_turn_fraction=1.0,
            cruise_speed=34,
            airborne=True,
            size=4,
        ),
        Collidable(COLLISION_POLYGONS["shahed"]),
        Health(10, 10),
        Faction("iran"),
        BotControl("shahed_intercept"),
    )


def _make_tanker(x: float, y: float) -> tuple:
    return (
        Transform(x=x, y=y, heading=0, speed=5),
        VehiclePhysics(
            vehicle_type="oil_tanker",
            max_speed=7.5,
            acceleration=1,
            drag=0.97,
            turn_rate=0.05,
            drift_factor=0.25,
            lateral_drag=0.45,
            size=220,
        ),
        Collidable(COLLISION_POLYGONS["oil_tanker"]),
        Health(100, 100),
        Faction("civilian"),
        BotControl("tanker_transit"),
    )


class TestShahedTankerCombat:
    def test_overlapping_shahed_dies_tanker_gets_breaches(self):
        s_comps = _make_shahed(100, 100)
        t_comps = _make_tanker(100, 100)  # same position = overlapping
        s_ent = esper.create_entity(*s_comps)
        t_ent = esper.create_entity(*t_comps)

        proc = CombatProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        # Shahed dies instantly
        assert esper.component_for_entity(s_ent, Health).hp == 0
        # Tanker survives but has hull breaches
        t_health = esper.component_for_entity(t_ent, Health)
        t_tf = esper.component_for_entity(t_ent, Transform)
        assert t_health.hp == 100  # still alive
        assert t_tf.hull_breaches > 0  # but breached

    def test_shahed_kill_adds_respawn_timer(self):
        s_comps = _make_shahed(100, 100)
        t_comps = _make_tanker(100, 100)
        s_ent = esper.create_entity(*s_comps)
        esper.create_entity(*t_comps)

        proc = CombatProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        assert esper.has_component(s_ent, RespawnTimer)

    def test_distant_shahed_and_tanker_survive(self):
        s_comps = _make_shahed(0, 0)
        t_comps = _make_tanker(10000, 10000)
        s_ent = esper.create_entity(*s_comps)
        t_ent = esper.create_entity(*t_comps)

        proc = CombatProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        assert esper.component_for_entity(s_ent, Health).hp == 10
        assert esper.component_for_entity(t_ent, Health).hp == 100

    def test_explosion_event_generated(self):
        esper.create_entity(*_make_shahed(100, 100))
        esper.create_entity(*_make_tanker(100, 100))

        proc = CombatProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        assert len(proc.events) == 1
        assert proc.events[0]["type"] == "explosion"
