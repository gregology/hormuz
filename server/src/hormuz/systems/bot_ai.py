"""Bot AI processor — thin esper adapter over the shared Lua AI.

All behavior logic lives in shared/ai/*.lua (see systems/ai_bridge.py) and is
identical to what runs in the playground. This adapter builds the per-tick
world view from esper components and applies the returned controls to
BotControl components. Bot state (target, waypoint, stamina) persists in
BotControl, so the Lua VM can be hot-reloaded without losing it; group
membership (convoy, escort assignment, pack) is part of that state.
"""

import logging

import esper

from hormuz.components import (
    BotControl,
    CargoState,
    Faction,
    Health,
    Transform,
    VehiclePhysics,
)
from hormuz.systems.ai_bridge import get_bridge

log = logging.getLogger(__name__)

_RELOAD_INTERVAL_TICKS = 60  # ~3s at 20Hz


class BotAIProcessor(esper.Processor):
    def __init__(self) -> None:
        self._tick = 0

    def process(self, dt: float = 0.05) -> None:
        self._tick += 1
        bridge = get_bridge()
        if self._tick % _RELOAD_INTERVAL_TICKS == 0:
            bridge.maybe_reload()

        entities: list[dict] = []
        for ent, (tf, phys, health, faction) in esper.get_components(
            Transform, VehiclePhysics, Health, Faction
        ):
            if health.hp <= 0:
                continue
            view: dict = {
                "id": ent,
                "type": phys.vehicle_type,
                "faction": faction.name,
                "x": tf.x,
                "y": tf.y,
                "heading": tf.heading,
                "speed": tf.speed,
                "hp": health.hp,
                "airborne": phys.airborne,
                "size": phys.size,
            }
            bot = esper.try_component(ent, BotControl)
            if bot is not None:
                cargo = esper.try_component(ent, CargoState)
                view["behavior"] = bot.behavior
                view["bot"] = {
                    "throttle": bot.throttle,
                    "rudder": bot.rudder,
                    "stamina": bot.stamina,
                    "waypoint_index": bot.waypoint_index,
                    "target": bot.target_entity,
                    "destination": cargo.destination if cargo else "oman",
                    "group": bot.group,
                }
            entities.append(view)

        entities.sort(key=lambda e: e["id"])
        controls, errors = bridge.compute(entities, dt)
        for err in errors:
            log.warning("AI error: %s", err)

        for c in controls:
            bot = esper.try_component(c["id"], BotControl)
            if bot is None:
                continue
            bot.throttle = c["throttle"]
            bot.rudder = c["rudder"]
            bot.target_entity = c["target"]
            bot.waypoint_index = c["waypoint_index"]
            bot.stamina = c["stamina"]
            bot.group = c["group"]
