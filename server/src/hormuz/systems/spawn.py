"""Spawn processor — respawns dead entities and detects tanker turnaround/exits."""

import math
import random

import esper

from hormuz.components import (
    Battery,
    BotControl,
    CargoState,
    Faction,
    Health,
    RespawnTimer,
    SpawnConfig,
    Transform,
    VehiclePhysics,
)
from hormuz.map_data import (
    GULF_DESTINATION,
    IRAN_SPAWNS,
    OMAN_DESTINATION,
    STRAIT_CENTER,
    random_frigate_gulf_spawn,
    random_frigate_oman_spawn,
    random_oman_spawn,
    random_quadcopter_spawn,
    random_speedboat_spawn,
    random_tanker_spawn,
)


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

    @staticmethod
    def _get_tanker_positions() -> list[tuple[float, float]]:
        """Collect positions of all alive tankers for proximity-based spawning."""
        positions: list[tuple[float, float]] = []
        for _, (tf, phys, health) in esper.get_components(Transform, VehiclePhysics, Health):
            if phys.vehicle_type == "oil_tanker" and health.hp > 0:
                positions.append((tf.x, tf.y))
        return positions

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

            dx = dest["position"][0] - tf.x
            dy = dest["position"][1] - tf.y
            if dx * dx + dy * dy > dest["radius"] ** 2:
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

            # Resolve behavior from SpawnConfig (persistent) or vehicle default
            spawn_cfg = esper.try_component(ent, SpawnConfig)
            if spawn_cfg is not None:
                behavior = spawn_cfg.behavior
            else:
                from hormuz.generated.vehicles import VEHICLES

                behavior = VEHICLES[phys.vehicle_type].ai_behavior

            # Respawn position based on vehicle type
            if faction.name == "civilian":
                # 50/50 chance to spawn at either end
                if random.random() < 0.5:
                    x, y, heading = random_tanker_spawn()
                    loaded, destination = True, "oman"
                else:
                    x, y, heading = random_oman_spawn()
                    loaded, destination = False, "gulf"
                # Update cargo state
                cargo = esper.try_component(ent, CargoState)
                if cargo is not None:
                    cargo.loaded = loaded
                    cargo.destination = destination
                else:
                    esper.add_component(ent, CargoState(loaded=loaded, destination=destination))
            elif faction.name == "us":
                if random.random() < 0.5:
                    x, y, heading = random_frigate_gulf_spawn()
                else:
                    x, y, heading = random_frigate_oman_spawn()
            else:
                if phys.vehicle_type == "speedboat":
                    x, y, heading = random_speedboat_spawn()
                elif phys.vehicle_type == "quadcopter":
                    tanker_positions = self._get_tanker_positions()
                    x, y, heading = random_quadcopter_spawn(tanker_positions)
                else:
                    spawn = random.choice(IRAN_SPAWNS)
                    x, y = spawn["position"]
                    heading = math.atan2(STRAIT_CENTER[1] - y, STRAIT_CENTER[0] - x)

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

            # Reset battery
            battery = esper.try_component(ent, Battery)
            if battery is not None:
                battery.charge = 100.0

            # Restore bot control
            if not esper.has_component(ent, BotControl):
                esper.add_component(ent, BotControl(behavior))

            esper.remove_component(ent, RespawnTimer)
