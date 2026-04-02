"""Shared entity lifecycle helpers — kill, respawn, spawn position logic."""

import math
import random

import esper

from hormuz.components import (
    Battery,
    BotControl,
    CargoState,
    Faction,
    Health,
    PlayerControl,
    RespawnTimer,
    SpawnConfig,
    Transform,
    VehiclePhysics,
)
from hormuz.map_data import (
    IRAN_SPAWNS,
    STRAIT_CENTER,
    random_oman_spawn,
    random_quadcopter_spawn,
    random_tanker_spawn,
)


def kill_entity(ent: int) -> None:
    """Mark an entity as dead: zero HP, remove control components, add respawn timer."""
    health = esper.component_for_entity(ent, Health)
    health.hp = 0
    if esper.has_component(ent, BotControl):
        esper.remove_component(ent, BotControl)
    if esper.has_component(ent, PlayerControl):
        esper.remove_component(ent, PlayerControl)
    if not esper.has_component(ent, RespawnTimer):
        esper.add_component(ent, RespawnTimer(remaining=3.0))


def get_tanker_positions() -> list[tuple[float, float]]:
    """Collect positions of all alive tankers for proximity-based spawning."""
    positions: list[tuple[float, float]] = []
    for _, (tf, phys, health) in esper.get_components(
        Transform, VehiclePhysics, Health
    ):
        if phys.vehicle_type == "oil_tanker" and health.hp > 0:
            positions.append((tf.x, tf.y))
    return positions


def random_spawn_position(
    vehicle_type: str, faction_name: str
) -> tuple[float, float, float]:
    """Return (x, y, heading) for a random spawn based on vehicle type and faction."""
    if faction_name == "civilian":
        if random.random() < 0.5:
            return random_tanker_spawn()
        return random_oman_spawn()

    if faction_name == "us":
        if random.random() < 0.5:
            return random_tanker_spawn()
        return random_oman_spawn()

    # Iran faction
    if vehicle_type == "quadcopter":
        tanker_positions = get_tanker_positions()
        return random_quadcopter_spawn(tanker_positions)

    # Shaheds and other Iran vehicles
    spawn = random.choice(IRAN_SPAWNS)
    x, y = spawn["position"]
    heading = math.atan2(STRAIT_CENTER[1] - y, STRAIT_CENTER[0] - x)
    return float(x), float(y), heading


def reset_transform(tf: Transform) -> None:
    """Reset a transform's dynamic state (speed, drift, flooding, etc.)."""
    tf.speed = 0.0
    tf.drift = 0.0
    tf.angular_velocity = 0.0
    tf.flood_level = 0.0
    tf.list_angle = 0.0
    tf.hull_breaches = 0
    tf.breach_side = 0.0


def teleport_to_spawn(ent: int) -> None:
    """Teleport an entity to a safe spawn point based on its vehicle type."""
    tf = esper.component_for_entity(ent, Transform)
    phys = esper.component_for_entity(ent, VehiclePhysics)
    faction_comp = esper.try_component(ent, Faction)
    faction_name = faction_comp.name if faction_comp else "civilian"

    tf.x, tf.y, tf.heading = random_spawn_position(phys.vehicle_type, faction_name)
    tf.speed = 0.0
    tf.drift = 0.0
    tf.angular_velocity = 0.0

    battery = esper.try_component(ent, Battery)
    if battery is not None:
        battery.charge = 100.0


def respawn_entity(ent: int) -> None:
    """Fully respawn a dead entity: reposition, restore health, restore bot control."""
    tf = esper.component_for_entity(ent, Transform)
    phys = esper.component_for_entity(ent, VehiclePhysics)
    health = esper.component_for_entity(ent, Health)

    faction = esper.component_for_entity(ent, Faction)

    # Get spawn position
    x, y, heading = random_spawn_position(phys.vehicle_type, faction.name)
    tf.x = x
    tf.y = y
    tf.heading = heading
    reset_transform(tf)
    # reset_transform zeroes speed etc., but we also set position above, so re-set heading
    tf.heading = heading

    health.hp = health.max_hp

    # Handle cargo state for tankers
    if faction.name == "civilian":
        loaded = random.random() < 0.5
        cargo = esper.try_component(ent, CargoState)
        if loaded:
            destination = "oman"
        else:
            destination = "gulf"
        if cargo is not None:
            cargo.loaded = loaded
            cargo.destination = destination
        else:
            esper.add_component(ent, CargoState(loaded=loaded, destination=destination))

    # Reset battery
    battery = esper.try_component(ent, Battery)
    if battery is not None:
        battery.charge = 100.0

    # Restore bot control
    if not esper.has_component(ent, BotControl):
        spawn_cfg = esper.try_component(ent, SpawnConfig)
        if spawn_cfg is not None:
            behavior = spawn_cfg.behavior
        else:
            from hormuz.generated.vehicles import VEHICLES

            behavior = VEHICLES[phys.vehicle_type].ai_behavior
        esper.add_component(ent, BotControl(behavior))

    esper.remove_component(ent, RespawnTimer)
