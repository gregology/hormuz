"""Spawn processor — respawns dead entities and detects tanker turnaround/exits."""

import math

import esper

from hormuz.components import (
    BotControl,
    CargoState,
    Faction,
    Health,
    RespawnTimer,
    Transform,
    VehiclePhysics,
)
from hormuz.entity_helpers import respawn_entity
from hormuz.map_data import GULF_DESTINATION, OMAN_DESTINATION

DESTINATION_DIST_SQ = 2000.0**2


class SpawnProcessor(esper.Processor):
    def __init__(self) -> None:
        super().__init__()
        self.tankers_delivered = 0
        self.tankers_sunk = 0
        # Events generated this tick
        self.events: list[dict] = []

    def process(self, dt: float = 0.05) -> None:
        self.events.clear()
        self._check_tanker_destinations()
        self._tick_respawn_timers(dt)

    def _check_tanker_destinations(self) -> None:
        """Tankers near their destination turn around (loaded<->empty, reverse route)."""
        for ent, (tf, phys, health, faction, cargo) in esper.get_components(
            Transform, VehiclePhysics, Health, Faction, CargoState
        ):
            if phys.vehicle_type != "oil_tanker" or health.hp <= 0:
                continue
            if faction.name != "civilian":
                continue

            # Check distance to current destination
            if cargo.destination == "oman":
                dest = OMAN_DESTINATION
            else:
                dest = GULF_DESTINATION

            dx = dest[0] - tf.x
            dy = dest[1] - tf.y
            if dx * dx + dy * dy > DESTINATION_DIST_SQ:
                continue

            # Tanker reached its destination — turn around
            if cargo.destination == "oman":
                # Loaded tanker delivered oil — becomes empty, heads back to Gulf
                self.tankers_delivered += 1
                cargo.loaded = False
                cargo.destination = "gulf"
                tf.heading = math.pi  # face west
                self.events.append({"type": "delivered", "x": tf.x, "y": tf.y})
            else:
                # Empty tanker arrived at Gulf — reload, head to Oman
                cargo.loaded = True
                cargo.destination = "oman"
                tf.heading = 0.0  # face east

            # Reset navigation state
            tf.speed = 0.0
            tf.drift = 0.0
            tf.angular_velocity = 0.0
            if esper.has_component(ent, BotControl):
                bot = esper.component_for_entity(ent, BotControl)
                bot.waypoint_index = 0

    def _tick_respawn_timers(self, dt: float) -> None:
        """Count down respawn timers and respawn when ready."""
        for ent, (timer, tf, phys, health, faction) in esper.get_components(
            RespawnTimer, Transform, VehiclePhysics, Health, Faction
        ):
            timer.remaining -= dt
            if timer.remaining > 0:
                continue
            respawn_entity(ent)
