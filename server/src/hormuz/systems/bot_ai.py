"""Bot AI processor — tanker waypoint following, shahed interception, frigate escort."""

import math

import esper

from hormuz.components import BotControl, CargoState, Faction, Health, Transform, VehiclePhysics
from hormuz.map_data import (
    GULF_DESTINATION,
    LANE_INBOUND,
    LANE_OUTBOUND,
    OMAN_DESTINATION,
    STRAIT_CENTER,
)
from hormuz.systems.combat import JAM_RADIUS_SQ

ESCORT_RADIUS = 500.0  # desired orbit distance from escorted tanker

# Shahed visual detection range — no radar, must see targets visually
SHAHED_VISUAL_RANGE = 5000.0
SHAHED_VISUAL_RANGE_SQ = SHAHED_VISUAL_RANGE * SHAHED_VISUAL_RANGE

# Frigate escort zone — outside these bounds, tankers are considered safe
ESCORT_ZONE_WEST = 50000.0
ESCORT_ZONE_EAST = 110000.0


def steer_toward(tf: Transform, target_x: float, target_y: float) -> float:
    """Return rudder value (-1 to 1) to steer toward a target point."""
    desired = math.atan2(target_y - tf.y, target_x - tf.x)
    diff = desired - tf.heading
    # Normalize to [-pi, pi]
    diff = (diff + math.pi) % (2 * math.pi) - math.pi
    return max(-1.0, min(1.0, diff * 2.0))


WAYPOINT_ADVANCE_DIST_SQ = 500.0**2
EXIT_DIST_SQ = 1500.0**2

# Route/destination lookup by cargo destination
_ROUTE_CONFIG = {
    "oman": (LANE_OUTBOUND, OMAN_DESTINATION),
    "gulf": (LANE_INBOUND, GULF_DESTINATION),
}


def run_tanker_ai(
    tf: Transform, waypoint_index: int, destination: str = "oman"
) -> tuple[float, float, int]:
    """Run tanker waypoint-following AI. Returns (throttle, rudder, new_waypoint_index).

    Extracted so it can be reused by the autopilot system for player-controlled tankers.
    """
    route, exit_point = _ROUTE_CONFIG.get(destination, _ROUTE_CONFIG["oman"])

    if waypoint_index < len(route):
        wx, wy = route[waypoint_index]
        dx = wx - tf.x
        dy = wy - tf.y
        if dx * dx + dy * dy < WAYPOINT_ADVANCE_DIST_SQ:
            waypoint_index += 1

    if waypoint_index < len(route):
        wx, wy = route[waypoint_index]
        rudder = steer_toward(tf, wx, wy)
    else:
        rudder = steer_toward(tf, exit_point[0], exit_point[1])

    return 1.0, rudder, waypoint_index


class BotAIProcessor(esper.Processor):
    def process(self, dt: float = 0.05) -> None:
        # Collect frigate positions once for jamming checks
        frigate_transforms: list[Transform] = []
        for _, (tf, phys, health) in esper.get_components(Transform, VehiclePhysics, Health):
            if phys.vehicle_type == "frigate" and health.hp > 0:
                frigate_transforms.append(tf)

        for ent, (tf, bot) in esper.get_components(Transform, BotControl):
            if bot.behavior == "tanker_transit":
                self._tanker_ai(ent, tf, bot)
            elif bot.behavior == "shahed_intercept":
                self._shahed_ai(ent, tf, bot, frigate_transforms)
            elif bot.behavior == "escort":
                self._escort_ai(ent, tf, bot)

    def _tanker_ai(self, ent: int, tf: Transform, bot: BotControl) -> None:
        cargo = esper.try_component(ent, CargoState)
        destination = cargo.destination if cargo else "oman"
        bot.throttle, bot.rudder, bot.waypoint_index = run_tanker_ai(
            tf, bot.waypoint_index, destination
        )

    def _shahed_ai(
        self,
        ent: int,
        tf: Transform,
        bot: BotControl,
        frigate_transforms: list[Transform],
    ) -> None:
        # Check if jammed by a nearby frigate
        jammed = False
        for f_tf in frigate_transforms:
            dx = f_tf.x - tf.x
            dy = f_tf.y - tf.y
            if dx * dx + dy * dy < JAM_RADIUS_SQ:
                jammed = True
                break

        if not jammed:
            best_dist_sq = float("inf")
            best_tf: Transform | None = None

            for t_ent, (t_tf, t_faction, t_health) in esper.get_components(
                Transform, Faction, Health
            ):
                if t_faction.name == "civilian" and t_health.hp > 0:
                    dx = t_tf.x - tf.x
                    dy = t_tf.y - tf.y
                    d_sq = dx * dx + dy * dy
                    if d_sq < best_dist_sq:
                        best_dist_sq = d_sq
                        best_tf = t_tf

            if best_tf is not None:
                bot.rudder = steer_toward(tf, best_tf.x, best_tf.y)
            else:
                bot.rudder = 0.0
        else:
            bot.rudder = 0.0  # jammed — can't steer

        bot.throttle = 1.0

    def _escort_ai(self, ent: int, tf: Transform, bot: BotControl) -> None:
        # Validate current escort target
        if bot.target_entity != 0:
            if not esper.entity_exists(bot.target_entity):
                bot.target_entity = 0
            else:
                health = esper.try_component(bot.target_entity, Health)
                if health is None or health.hp <= 0:
                    bot.target_entity = 0
                else:
                    # Release tanker that has left the danger zone (safe now)
                    t_tf = esper.component_for_entity(bot.target_entity, Transform)
                    if t_tf.x < ESCORT_ZONE_WEST or t_tf.x > ESCORT_ZONE_EAST:
                        bot.target_entity = 0

        # Acquire nearest alive tanker within the danger zone
        if bot.target_entity == 0:
            best_dist_sq = float("inf")
            for t_ent, (t_tf, t_phys, t_health) in esper.get_components(
                Transform, VehiclePhysics, Health
            ):
                if t_phys.vehicle_type != "oil_tanker" or t_health.hp <= 0:
                    continue
                # Only escort tankers in the danger zone
                if t_tf.x < ESCORT_ZONE_WEST or t_tf.x > ESCORT_ZONE_EAST:
                    continue
                dx = t_tf.x - tf.x
                dy = t_tf.y - tf.y
                d_sq = dx * dx + dy * dy
                if d_sq < best_dist_sq:
                    best_dist_sq = d_sq
                    bot.target_entity = t_ent

        if bot.target_entity == 0:
            # No tanker to escort — head back toward strait center
            bot.rudder = steer_toward(tf, STRAIT_CENTER[0], STRAIT_CENTER[1])
            bot.throttle = 0.7
            return

        target_tf = esper.component_for_entity(bot.target_entity, Transform)
        dx = target_tf.x - tf.x
        dy = target_tf.y - tf.y
        dist = math.sqrt(dx * dx + dy * dy)

        if dist > ESCORT_RADIUS * 2:
            # Far from tanker — head straight toward it
            bot.rudder = steer_toward(tf, target_tf.x, target_tf.y)
            bot.throttle = 1.0
        else:
            # Near tanker — orbit clockwise
            angle = math.atan2(tf.y - target_tf.y, tf.x - target_tf.x)
            target_angle = angle + 0.5  # advance ~29° on circle
            orbit_x = target_tf.x + math.cos(target_angle) * ESCORT_RADIUS
            orbit_y = target_tf.y + math.sin(target_angle) * ESCORT_RADIUS
            bot.rudder = steer_toward(tf, orbit_x, orbit_y)

            if dist > ESCORT_RADIUS * 1.3:
                bot.throttle = 1.0
            elif dist < ESCORT_RADIUS * 0.7:
                bot.throttle = 0.3
            else:
                bot.throttle = 0.7
