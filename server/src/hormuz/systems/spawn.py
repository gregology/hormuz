"""Spawn processor — respawns dead entities and detects tanker exits."""

import random

import esper

from hormuz.components import (
    BotControl,
    Faction,
    Health,
    RespawnTimer,
    Transform,
    VehiclePhysics,
)
from hormuz.map_data import IRAN_SPAWNS, TANKER_EXITS, random_tanker_spawn

EXIT_DIST_SQ = 1500.0**2

_TANKER_EXIT_MVP = TANKER_EXITS[0]  # Gulf of Oman


class SpawnProcessor(esper.Processor):
    def __init__(self) -> None:
        super().__init__()
        self.tankers_delivered = 0
        self.tankers_sunk = 0
        # Events generated this tick
        self.events: list[dict] = []

    def process(self, dt: float = 0.05) -> None:
        self.events.clear()
        self._check_tanker_exits()
        self._tick_respawn_timers(dt)

    def _check_tanker_exits(self) -> None:
        """Tankers near an exit point are delivered and queued for respawn."""
        for ent, (tf, phys, health, faction) in esper.get_components(
            Transform, VehiclePhysics, Health, Faction
        ):
            if phys.vehicle_type != "oil_tanker" or health.hp <= 0:
                continue
            if faction.name != "civilian":
                continue

            dx = _TANKER_EXIT_MVP[0] - tf.x
            dy = _TANKER_EXIT_MVP[1] - tf.y
            if dx * dx + dy * dy < EXIT_DIST_SQ:
                self.tankers_delivered += 1
                health.hp = 0
                if esper.has_component(ent, BotControl):
                    esper.remove_component(ent, BotControl)

                if not esper.has_component(ent, RespawnTimer):
                    esper.add_component(ent, RespawnTimer(remaining=2.0))

                self.events.append({"type": "delivered", "x": tf.x, "y": tf.y})

    def _tick_respawn_timers(self, dt: float) -> None:
        """Count down respawn timers and respawn when ready."""
        for ent, (timer, tf, phys, health, faction) in esper.get_components(
            RespawnTimer, Transform, VehiclePhysics, Health, Faction
        ):
            timer.remaining -= dt
            if timer.remaining > 0:
                continue

            # Respawn
            if faction.name == "civilian":
                x, y, heading = random_tanker_spawn()
                behavior = "tanker_transit"
            elif faction.name == "us":
                x, y, heading = random_tanker_spawn()
                behavior = "escort"
            else:
                spawn = random.choice(IRAN_SPAWNS)
                x, y = spawn["position"]
                heading = spawn["heading"]
                behavior = "shahed_intercept"

            tf.x = float(x)
            tf.y = float(y)
            tf.heading = heading
            tf.speed = 0.0
            tf.drift = 0.0
            tf.angular_velocity = 0.0
            tf.flood_level = 0.0
            tf.list_angle = 0.0
            tf.hull_breaches = 0
            tf.breach_side = 0.0
            health.hp = health.max_hp

            # Restore bot control
            if not esper.has_component(ent, BotControl):
                esper.add_component(ent, BotControl(behavior))

            esper.remove_component(ent, RespawnTimer)
