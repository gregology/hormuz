"""Bot AI processor — emergent convoy behavior from simple local rules.

Inspired by colony insects: tankers follow trails and avoid danger,
frigates are attracted to tanker presence, rush toward danger, and
repel each other. Complex convoy formations emerge from these local
interactions without any central coordination.
"""

import math

import esper

from hormuz.components import BotControl, CargoState, Faction, Health, Transform, VehiclePhysics
from hormuz.generated.map_data import EXCLUSION_ZONES
from hormuz.generated.terrain_grid import is_land
from hormuz.generated.vehicles import JAM_RADIUS
from hormuz.map_data import (
    GULF_DESTINATION,
    LANE_ALT_INBOUND,
    LANE_ALT_OUTBOUND,
    OMAN_DESTINATION,
    SPEEDBOAT_SPAWNS,
    STRAIT_CENTER,
)
from hormuz.systems.danger_scent import nearest_danger, prune_danger_scents
from hormuz.systems.threat_picture import build_threat_picture, get_threats_near

JAM_RADIUS_SQ = JAM_RADIUS * JAM_RADIUS


# --- Tanker constants ---
# Brake when a tanker ahead is within this distance
TANKER_BRAKE_RANGE = 400.0
TANKER_BRAKE_RANGE_SQ = TANKER_BRAKE_RANGE * TANKER_BRAKE_RANGE
# Min throttle when braking behind another tanker
TANKER_BRAKE_MIN_THROTTLE = 0.4
# Danger avoidance: how far tankers sense danger scent
TANKER_DANGER_RANGE = 3000.0
TANKER_DANGER_RANGE_SQ = TANKER_DANGER_RANGE * TANKER_DANGER_RANGE
# Rudder bias strength when avoiding danger
TANKER_DANGER_RUDDER = 0.3

# --- Frigate constants ---
# Offset distance: frigates prefer to be this far from their assigned tanker
FRIGATE_OFFSET_DIST = 800.0
# Danger attraction range — large enough to sense attacks across most of the lane
FRIGATE_DANGER_RANGE = 25000.0
FRIGATE_DANGER_RANGE_SQ = FRIGATE_DANGER_RANGE * FRIGATE_DANGER_RANGE
# Frigate-frigate repulsion range
FRIGATE_REPEL_RANGE = 2000.0
FRIGATE_REPEL_RANGE_SQ = FRIGATE_REPEL_RANGE * FRIGATE_REPEL_RANGE
# Steering weights (summed, then clamped to [-1, 1])
WEIGHT_PRESENCE = 0.6
WEIGHT_DANGER = 1.0
WEIGHT_REPEL = 0.5
# Frigate cruise throttle when near tankers
FRIGATE_CRUISE_THROTTLE = 0.6

# Escort pressure scoring: use d^1 (linear) and (1+pressure)^3 (cubic)
# so unescorted tankers far away outscore crowded nearby ones
ESCORT_PRESSURE_POWER = 3

# Patrol anchors: lane endpoints where frigates idle when no tankers exist.
# Derived from the first/last waypoints of the shipping lanes.
PATROL_ANCHORS: list[tuple[float, float]] = []

# --- Threat proximity scoring for escort AI ---
# Radius around a tanker to count nearby threats from the coalition picture
ESCORT_THREAT_RADIUS = 5000.0
ESCORT_THREAT_RADIUS_SQ = ESCORT_THREAT_RADIUS * ESCORT_THREAT_RADIUS
# Score multiplier per nearby threat (additive: 1 + k * count)
ESCORT_THREAT_WEIGHT = 2.0

# Shahed visual detection range — no radar, must see targets visually
SHAHED_VISUAL_RANGE = 5000.0
SHAHED_VISUAL_RANGE_SQ = SHAHED_VISUAL_RANGE * SHAHED_VISUAL_RANGE

# Quadcopter visual detection range — FPV camera, better optics than shahed
QUADCOPTER_VISUAL_RANGE = 8000.0
QUADCOPTER_VISUAL_RANGE_SQ = QUADCOPTER_VISUAL_RANGE * QUADCOPTER_VISUAL_RANGE

# --- Drone swarm constants ---
# Drone-drone repulsion range (approach angle diversification)
DRONE_REPEL_RANGE_SHAHED = 1000.0
DRONE_REPEL_RANGE_SHAHED_SQ = DRONE_REPEL_RANGE_SHAHED * DRONE_REPEL_RANGE_SHAHED
DRONE_REPEL_RANGE_QUAD = 500.0
DRONE_REPEL_RANGE_QUAD_SQ = DRONE_REPEL_RANGE_QUAD * DRONE_REPEL_RANGE_QUAD
DRONE_REPEL_WEIGHT = 0.4
# Target pressure: score bonus for current target (prevents oscillation)
TARGET_STICKINESS = 0.5

# --- Speedboat wolf pack constants ---
# Speedboat visual detection range (bow gun range is 200u, approach from further)
SPEEDBOAT_VISUAL_RANGE = 8000.0
SPEEDBOAT_VISUAL_RANGE_SQ = SPEEDBOAT_VISUAL_RANGE * SPEEDBOAT_VISUAL_RANGE
# Distance at which speedboat transitions to attack run (matches bow gun range)
SPEEDBOAT_ATTACK_RANGE = 300.0
# Danger attraction range (rush to ongoing attacks)
SPEEDBOAT_DANGER_RANGE = 6000.0
SPEEDBOAT_DANGER_RANGE_SQ = SPEEDBOAT_DANGER_RANGE * SPEEDBOAT_DANGER_RANGE
SPEEDBOAT_WEIGHT_DANGER = 0.6
# Frigate evasion: flee well before weapons range (autocannon is 1500u)
SPEEDBOAT_EVASION_RANGE = 1500.0
SPEEDBOAT_EVASION_RANGE_SQ = SPEEDBOAT_EVASION_RANGE * SPEEDBOAT_EVASION_RANGE
SPEEDBOAT_EVASION_WEIGHT = 1.5
# Frigate proximity penalty for target selection — avoid escorted tankers
SPEEDBOAT_FRIGATE_PROXIMITY = 4000.0
SPEEDBOAT_FRIGATE_PROXIMITY_SQ = SPEEDBOAT_FRIGATE_PROXIMITY * SPEEDBOAT_FRIGATE_PROXIMITY
# Pack repulsion (tighter than drones — they're smaller and coordinate closely)
SPEEDBOAT_REPEL_RANGE = 300.0
SPEEDBOAT_REPEL_RANGE_SQ = SPEEDBOAT_REPEL_RANGE * SPEEDBOAT_REPEL_RANGE
# Stamina: foraging wasp model — hunt while bold, retreat to recharge
SPEEDBOAT_STAMINA_DRAIN = 0.015  # per second while hunting (~45s of aggression after transit)
SPEEDBOAT_STAMINA_DRAIN_ATTACK = 0.04  # per second while in attack range (burns faster)
SPEEDBOAT_STAMINA_RECHARGE = 0.1  # per second near spawn (~7s to refuel)
SPEEDBOAT_STAMINA_THRESHOLD = 0.3  # retreat when stamina falls below this
SPEEDBOAT_HOME_RADIUS = 1500.0  # distance from spawn to start recharging
SPEEDBOAT_HOME_RADIUS_SQ = SPEEDBOAT_HOME_RADIUS * SPEEDBOAT_HOME_RADIUS

# Precompute spawn positions as tuples for distance checks
_SPEEDBOAT_HOME_POSITIONS: list[tuple[float, float]] = [
    (s["position"][0], s["position"][1]) for s in SPEEDBOAT_SPAWNS
]

# --- Collision avoidance constants ---
AVOID_VESSEL_FACTOR = 0.8
AVOID_VESSEL_STRENGTH = 0.5

_LAND_PROBE_ANGLES = (0.0, -0.35, 0.35, -0.7, 0.7, -1.05, 1.05)
AVOID_LAND_STRENGTH = 0.8

EXCLUSION_BUFFER = 2000.0

TRANSIT_DIST_SQ = 5000.0**2

WAYPOINT_ADVANCE_DIST_SQ = 500.0**2
EXIT_DIST_SQ = 1500.0**2

# Route/destination lookup by cargo destination
_ROUTE_CONFIG = {
    "oman": (LANE_ALT_OUTBOUND, OMAN_DESTINATION["position"]),
    "gulf": (LANE_ALT_INBOUND, GULF_DESTINATION["position"]),
}


def _init_patrol_anchors() -> None:
    """Populate PATROL_ANCHORS from lane endpoints and midpoints.

    Spreads idle frigates across the full lane instead of bunching at the ends.
    """
    if PATROL_ANCHORS:
        return
    # West gate: start of outbound / end of inbound
    PATROL_ANCHORS.append(LANE_ALT_OUTBOUND[0])
    # Mid-lane anchors for geographic spread
    mid = len(LANE_ALT_OUTBOUND) // 2
    quarter = len(LANE_ALT_OUTBOUND) // 4
    if quarter > 0 and quarter != mid:
        PATROL_ANCHORS.append(LANE_ALT_OUTBOUND[quarter])
    if mid > 0:
        PATROL_ANCHORS.append(LANE_ALT_OUTBOUND[mid])
    three_quarter = mid + quarter
    if three_quarter < len(LANE_ALT_OUTBOUND) and three_quarter != mid:
        PATROL_ANCHORS.append(LANE_ALT_OUTBOUND[three_quarter])
    # East gate: end of outbound / start of inbound
    PATROL_ANCHORS.append(LANE_ALT_OUTBOUND[-1])


_init_patrol_anchors()


def steer_toward(tf: Transform, target_x: float, target_y: float) -> float:
    """Return rudder value (-1 to 1) to steer toward a target point."""
    desired = math.atan2(target_y - tf.y, target_x - tf.x)
    diff = desired - tf.heading
    diff = (diff + math.pi) % (2 * math.pi) - math.pi
    return max(-1.0, min(1.0, diff * 2.0))


def _find_lane_waypoint(
    tf_x: float, tf_y: float, target_x: float, target_y: float
) -> tuple[float, float] | None:
    """Return nearest shipping lane waypoint that makes progress toward the target."""
    going_west = target_x < tf_x
    lane = LANE_ALT_INBOUND if going_west else LANE_ALT_OUTBOUND
    frig_to_target_sq = (target_x - tf_x) ** 2 + (target_y - tf_y) ** 2

    best_wp = None
    best_dist_sq = float("inf")

    for wx, wy in lane:
        wp_to_target_sq = (target_x - wx) ** 2 + (target_y - wy) ** 2
        if wp_to_target_sq >= frig_to_target_sq:
            continue
        wp_to_us_sq = (wx - tf_x) ** 2 + (wy - tf_y) ** 2
        if wp_to_us_sq < best_dist_sq:
            best_dist_sq = wp_to_us_sq
            best_wp = (wx, wy)

    return best_wp


def _point_in_polygon(x: float, y: float, polygon: tuple) -> bool:
    """Ray-casting point-in-polygon test."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def _dist_to_polygon_edge(x: float, y: float, polygon: tuple) -> float:
    """Minimum distance from point to the nearest edge of the polygon."""
    best = float("inf")
    n = len(polygon)
    for i in range(n):
        ax, ay = polygon[i]
        bx, by = polygon[(i + 1) % n]
        dx, dy = bx - ax, by - ay
        len_sq = dx * dx + dy * dy
        if len_sq == 0:
            d = math.hypot(x - ax, y - ay)
        else:
            t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / len_sq))
            d = math.hypot(x - (ax + t * dx), y - (ay + t * dy))
        if d < best:
            best = d
    return best


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
        # Prune expired danger scents once per tick
        prune_danger_scents()

        # Collect frigate positions once for jamming checks
        frigate_transforms: list[Transform] = []
        for _, (tf, phys, health) in esper.get_components(Transform, VehiclePhysics, Health):
            if phys.vehicle_type == "frigate" and health.hp > 0:
                frigate_transforms.append(tf)

        # Collect alive tanker transforms for frigate presence sensing
        tanker_transforms: list[Transform] = []
        for _, (tf, phys, health) in esper.get_components(Transform, VehiclePhysics, Health):
            if phys.vehicle_type == "oil_tanker" and health.hp > 0:
                tanker_transforms.append(tf)

        # Collect alive drone and speedboat positions for swarm repulsion
        shahed_transforms: list[tuple[int, Transform]] = []
        quadcopter_transforms: list[tuple[int, Transform]] = []
        speedboat_transforms: list[tuple[int, Transform]] = []
        for ent, (tf, phys, health, bot) in esper.get_components(
            Transform, VehiclePhysics, Health, BotControl
        ):
            if health.hp <= 0:
                continue
            if phys.vehicle_type == "shahed":
                shahed_transforms.append((ent, tf))
            elif phys.vehicle_type == "quadcopter":
                quadcopter_transforms.append((ent, tf))
            elif phys.vehicle_type == "speedboat":
                speedboat_transforms.append((ent, tf))

        # Build coalition threat picture from radar detections
        radar_vessels: list[tuple[str, float, float, str]] = []
        enemy_vessels: list[tuple[int, float, float, str]] = []
        for ent, (tf, phys, health, faction) in esper.get_components(
            Transform, VehiclePhysics, Health, Faction
        ):
            if health.hp <= 0:
                continue
            if faction.name in ("us", "civilian"):
                radar_vessels.append((phys.vehicle_type, tf.x, tf.y, faction.name))
            elif faction.name == "iran":
                enemy_vessels.append((ent, tf.x, tf.y, phys.vehicle_type))
        build_threat_picture(radar_vessels, enemy_vessels)

        # Build separate pressure counts for drones, frigates, and speedboats.
        # Each group targets independently so their pressure pools are separate.
        drone_target_counts: dict[int, int] = {}
        escort_target_counts: dict[int, int] = {}
        speedboat_target_counts: dict[int, int] = {}
        for _, (_, bot) in esper.get_components(Transform, BotControl):
            if bot.target_entity == 0:
                continue
            if bot.behavior in ("shahed_intercept", "quadcopter_intercept"):
                drone_target_counts[bot.target_entity] = (
                    drone_target_counts.get(bot.target_entity, 0) + 1
                )
            elif bot.behavior == "escort":
                escort_target_counts[bot.target_entity] = (
                    escort_target_counts.get(bot.target_entity, 0) + 1
                )
            elif bot.behavior == "swarm_attack":
                speedboat_target_counts[bot.target_entity] = (
                    speedboat_target_counts.get(bot.target_entity, 0) + 1
                )

        # Behavior dispatch
        for ent, (tf, bot) in esper.get_components(Transform, BotControl):
            if bot.behavior == "tanker_transit":
                self._tanker_ai(ent, tf, bot, tanker_transforms)
            elif bot.behavior == "shahed_intercept":
                self._shahed_ai(
                    ent, tf, bot, frigate_transforms,
                    shahed_transforms, drone_target_counts,
                )
            elif bot.behavior == "quadcopter_intercept":
                self._quadcopter_ai(
                    ent, tf, bot,
                    quadcopter_transforms, drone_target_counts,
                )
            elif bot.behavior == "escort":
                self._escort_ai(
                    ent, tf, bot, frigate_transforms, escort_target_counts,
                )
            elif bot.behavior == "swarm_attack":
                self._speedboat_ai(
                    ent, tf, bot,
                    speedboat_transforms, speedboat_target_counts,
                    frigate_transforms, dt,
                )

        # --- Collision avoidance post-processing ---
        ships: list[tuple[int, Transform, VehiclePhysics, str]] = []
        for ent, (tf, phys, health, faction) in esper.get_components(
            Transform, VehiclePhysics, Health, Faction
        ):
            if not phys.airborne and health.hp > 0:
                ships.append((ent, tf, phys, faction.name))

        for ent, (tf, bot, phys, faction) in esper.get_components(
            Transform, BotControl, VehiclePhysics, Faction
        ):
            if not phys.airborne:
                self._apply_avoidance(ent, tf, bot, phys, faction.name, ships)

    # ------------------------------------------------------------------
    # Tanker behavior
    # ------------------------------------------------------------------

    def _tanker_ai(
        self,
        ent: int,
        tf: Transform,
        bot: BotControl,
        tanker_transforms: list[Transform],
    ) -> None:
        """Follow lane waypoints. Brake for tankers ahead. Drift away from danger."""
        cargo = esper.try_component(ent, CargoState)
        destination = cargo.destination if cargo else "oman"

        # Base behavior: follow waypoints
        throttle, rudder, bot.waypoint_index = run_tanker_ai(
            tf, bot.waypoint_index, destination
        )

        # Rule 2: Slow down if a tanker is ahead within braking range
        cos_h = math.cos(tf.heading)
        sin_h = math.sin(tf.heading)
        for t_tf in tanker_transforms:
            if t_tf is tf:
                continue
            dx = t_tf.x - tf.x
            dy = t_tf.y - tf.y
            d_sq = dx * dx + dy * dy
            if d_sq > TANKER_BRAKE_RANGE_SQ:
                continue
            # Only brake for tankers ahead (dot product with heading)
            dot = dx * cos_h + dy * sin_h
            if dot <= 0:
                continue
            # Proportional braking: closer = slower
            dist = math.sqrt(d_sq)
            t = dist / TANKER_BRAKE_RANGE  # 0 at contact, 1 at max range
            brake_throttle = TANKER_BRAKE_MIN_THROTTLE + t * (1.0 - TANKER_BRAKE_MIN_THROTTLE)
            throttle = min(throttle, brake_throttle)

        # Rule 3: Drift away from danger scent
        danger = nearest_danger(tf.x, tf.y, TANKER_DANGER_RANGE_SQ)
        if danger is not None:
            dx, dy, strength = danger
            # Steer perpendicular to danger direction (away from it)
            # Cross product with heading determines which side danger is on
            cross = cos_h * dy - sin_h * dx
            if cross >= 0:
                rudder -= TANKER_DANGER_RUDDER * strength
            else:
                rudder += TANKER_DANGER_RUDDER * strength
            rudder = max(-1.0, min(1.0, rudder))

        bot.throttle = throttle
        bot.rudder = rudder

    # ------------------------------------------------------------------
    # Frigate behavior
    # ------------------------------------------------------------------

    def _escort_ai(
        self,
        ent: int,
        tf: Transform,
        bot: BotControl,
        frigate_transforms: list[Transform],
        escort_target_counts: dict[int, int],
    ) -> None:
        """Three local rules: escort least-contested tanker, rush to danger, repel frigates."""
        rudder_sum = 0.0

        # Rule 1: Pick a tanker using pressure scoring (least-contested, closest)
        # Linear distance + cubic pressure so unescorted far tankers outscore crowded near ones
        tanker_tf = self._pick_drone_target(
            tf, bot, ("civilian",), float("inf"), escort_target_counts,
            pressure_power=ESCORT_PRESSURE_POWER, use_linear_distance=True,
            threat_boost=True,
        )

        if tanker_tf is not None:
            dx = tanker_tf.x - tf.x
            dy = tanker_tf.y - tf.y
            dist = math.sqrt(dx * dx + dy * dy)

            if dist > FRIGATE_OFFSET_DIST:
                # Navigate toward tanker — use lane waypoints if far to avoid islands
                if dist > TRANSIT_DIST_SQ**0.5:
                    wp = _find_lane_waypoint(tf.x, tf.y, tanker_tf.x, tanker_tf.y)
                    if wp is not None:
                        rudder_sum += steer_toward(tf, wp[0], wp[1]) * WEIGHT_PRESENCE
                    else:
                        rudder_sum += steer_toward(tf, tanker_tf.x, tanker_tf.y) * WEIGHT_PRESENCE
                else:
                    rudder_sum += steer_toward(tf, tanker_tf.x, tanker_tf.y) * WEIGHT_PRESENCE
            else:
                # At desired offset — match tanker's heading direction
                cos_th = math.cos(tanker_tf.heading)
                sin_th = math.sin(tanker_tf.heading)
                ahead_x = tf.x + cos_th * 500.0
                ahead_y = tf.y + sin_th * 500.0
                rudder_sum += steer_toward(tf, ahead_x, ahead_y) * WEIGHT_PRESENCE * 0.5

        # Rule 2: Attract toward danger scent
        danger = nearest_danger(tf.x, tf.y, FRIGATE_DANGER_RANGE_SQ)
        if danger is not None:
            dx, dy, strength = danger
            target_x = tf.x + dx
            target_y = tf.y + dy
            rudder_sum += steer_toward(tf, target_x, target_y) * WEIGHT_DANGER * strength

        # Rule 3: Repel from other frigates
        for f_tf in frigate_transforms:
            if f_tf is tf:
                continue
            dx = f_tf.x - tf.x
            dy = f_tf.y - tf.y
            d_sq = dx * dx + dy * dy
            if d_sq > FRIGATE_REPEL_RANGE_SQ or d_sq < 1.0:
                continue
            dist = math.sqrt(d_sq)
            repel_strength = (1.0 - dist / FRIGATE_REPEL_RANGE) * WEIGHT_REPEL
            rudder_sum -= steer_toward(tf, f_tf.x, f_tf.y) * repel_strength

        # No tanker or danger — patrol toward the least-covered lane endpoint
        if tanker_tf is None and danger is None:
            px, py = self._pick_patrol_anchor(tf, frigate_transforms)
            dx = px - tf.x
            dy = py - tf.y
            if dx * dx + dy * dy > TRANSIT_DIST_SQ:
                wp = _find_lane_waypoint(tf.x, tf.y, px, py)
                if wp is not None:
                    rudder_sum = steer_toward(tf, wp[0], wp[1])
                else:
                    rudder_sum = steer_toward(tf, px, py)
            else:
                rudder_sum = steer_toward(tf, px, py)

        bot.rudder = max(-1.0, min(1.0, rudder_sum))

        # Throttle: fast when far from tanker, cruise when near
        if tanker_tf is not None:
            dx = tanker_tf.x - tf.x
            dy = tanker_tf.y - tf.y
            dist = math.sqrt(dx * dx + dy * dy)
            if dist > FRIGATE_OFFSET_DIST * 2:
                bot.throttle = 1.0
            else:
                bot.throttle = FRIGATE_CRUISE_THROTTLE
        elif danger is not None:
            bot.throttle = 1.0
        else:
            bot.throttle = 0.7

    # ------------------------------------------------------------------
    # Speedboat wolf pack behavior
    # ------------------------------------------------------------------

    def _speedboat_ai(
        self,
        ent: int,
        tf: Transform,
        bot: BotControl,
        speedboat_swarm: list[tuple[int, Transform]],
        speedboat_target_counts: dict[int, int],
        frigate_transforms: list[Transform],
        dt: float = 0.05,
    ) -> None:
        """Wolf pack attack with stamina-based hit-and-run cycles.

        Stamina drains while hunting, recharges near spawn. Below threshold
        the speedboat retreats home. Frigate evasion overrides everything.
        """

        # --- Stamina: recharge near home, drain while out ---
        near_home = False
        for hx, hy in _SPEEDBOAT_HOME_POSITIONS:
            dx = hx - tf.x
            dy = hy - tf.y
            if dx * dx + dy * dy < SPEEDBOAT_HOME_RADIUS_SQ:
                near_home = True
                break

        if near_home:
            bot.stamina = min(1.0, bot.stamina + SPEEDBOAT_STAMINA_RECHARGE * dt)
        else:
            # Drain faster when in attack range of a target
            drain = SPEEDBOAT_STAMINA_DRAIN
            if bot.target_entity != 0:
                t_tf = esper.try_component(bot.target_entity, Transform)
                if t_tf is not None:
                    tdx = t_tf.x - tf.x
                    tdy = t_tf.y - tf.y
                    if tdx * tdx + tdy * tdy < SPEEDBOAT_ATTACK_RANGE * SPEEDBOAT_ATTACK_RANGE:
                        drain = SPEEDBOAT_STAMINA_DRAIN_ATTACK
            bot.stamina = max(0.0, bot.stamina - drain * dt)

        # --- Frigate evasion: highest priority, always active ---
        nearest_frigate_dist_sq = float("inf")
        nearest_frigate_tf: Transform | None = None
        for f_tf in frigate_transforms:
            fdx = f_tf.x - tf.x
            fdy = f_tf.y - tf.y
            fd_sq = fdx * fdx + fdy * fdy
            if fd_sq < nearest_frigate_dist_sq:
                nearest_frigate_dist_sq = fd_sq
                nearest_frigate_tf = f_tf

        if nearest_frigate_tf is not None and nearest_frigate_dist_sq < SPEEDBOAT_EVASION_RANGE_SQ:
            dist_f = math.sqrt(nearest_frigate_dist_sq)
            proximity = 1.0 - dist_f / SPEEDBOAT_EVASION_RANGE
            evasion_rudder = -steer_toward(tf, nearest_frigate_tf.x, nearest_frigate_tf.y)
            evasion_strength = min(1.0, proximity * SPEEDBOAT_EVASION_WEIGHT)
            bot.rudder = max(-1.0, min(1.0, evasion_rudder * evasion_strength))
            bot.throttle = 1.0
            self._release_speedboat_target(bot, speedboat_target_counts)
            return

        # --- Retreat: stamina depleted, head to nearest spawn ---
        if bot.stamina <= SPEEDBOAT_STAMINA_THRESHOLD and not near_home:
            best_home = _SPEEDBOAT_HOME_POSITIONS[0]
            best_dist_sq = float("inf")
            for hx, hy in _SPEEDBOAT_HOME_POSITIONS:
                dx = hx - tf.x
                dy = hy - tf.y
                d_sq = dx * dx + dy * dy
                if d_sq < best_dist_sq:
                    best_dist_sq = d_sq
                    best_home = (hx, hy)
            bot.rudder = steer_toward(tf, best_home[0], best_home[1])
            bot.throttle = 1.0
            self._release_speedboat_target(bot, speedboat_target_counts)
            return

        # --- Hunt: stamina is good, attack tankers ---
        target_tf = self._pick_drone_target(
            tf, bot, ("civilian",), SPEEDBOAT_VISUAL_RANGE_SQ,
            speedboat_target_counts,
            frigate_penalty_transforms=frigate_transforms,
        )

        rudder = 0.0
        throttle = 1.0

        if target_tf is not None:
            dx = target_tf.x - tf.x
            dy = target_tf.y - tf.y
            dist = math.sqrt(dx * dx + dy * dy)

            if dist > SPEEDBOAT_ATTACK_RANGE:
                rudder = steer_toward(tf, target_tf.x, target_tf.y)
            else:
                cos_th = math.cos(target_tf.heading)
                sin_th = math.sin(target_tf.heading)
                ahead_x = target_tf.x + cos_th * 200.0
                ahead_y = target_tf.y + sin_th * 200.0
                rudder = steer_toward(tf, ahead_x, ahead_y)
                throttle = 0.5 + 0.5 * (dist / SPEEDBOAT_ATTACK_RANGE)
        else:
            rudder = steer_toward(tf, STRAIT_CENTER[0], STRAIT_CENTER[1])
            throttle = 0.7

        # Danger attraction: rush toward active attacks (only while hunting)
        danger = nearest_danger(tf.x, tf.y, SPEEDBOAT_DANGER_RANGE_SQ)
        if danger is not None:
            ddx, ddy, strength = danger
            target_x = tf.x + ddx
            target_y = tf.y + ddy
            rudder += steer_toward(tf, target_x, target_y) * SPEEDBOAT_WEIGHT_DANGER * strength

        # Pack repulsion
        rudder += self._drone_repulsion(
            ent, tf, speedboat_swarm,
            SPEEDBOAT_REPEL_RANGE_SQ, SPEEDBOAT_REPEL_RANGE,
        )

        bot.rudder = max(-1.0, min(1.0, rudder))
        bot.throttle = throttle

    @staticmethod
    def _release_speedboat_target(
        bot: BotControl, speedboat_target_counts: dict[int, int]
    ) -> None:
        """Clear the speedboat's target and update pressure counts."""
        if bot.target_entity != 0:
            speedboat_target_counts[bot.target_entity] = max(
                0, speedboat_target_counts.get(bot.target_entity, 1) - 1
            )
            bot.target_entity = 0

    # ------------------------------------------------------------------
    # Iranian drone behaviors
    # ------------------------------------------------------------------

    @staticmethod
    def _pick_drone_target(
        tf: Transform,
        bot: BotControl,
        factions: tuple[str, ...],
        max_range_sq: float,
        drone_target_counts: dict[int, int],
        pressure_power: int = 1,
        use_linear_distance: bool = False,
        threat_boost: bool = False,
        frigate_penalty_transforms: list[Transform] | None = None,
    ) -> Transform | None:
        """Score all valid targets by distance and pressure, pick the best.

        Always re-evaluates — the current target gets a stickiness bonus to prevent
        oscillation, but if pressure is high enough a drone will switch to a less
        contested target. Updates drone_target_counts in-place so subsequent drones
        in the same tick see accurate pressure.

        Args:
            pressure_power: exponent on (1 + pressure) term. Higher = stronger
                aversion to crowded targets. Drones use 1 (default), escorts use 3.
            use_linear_distance: if True, score uses d instead of d². Escorts use
                linear distance so far-away unescorted tankers can outscore nearby
                crowded ones.
            threat_boost: if True, multiply score by (1 + ESCORT_THREAT_WEIGHT *
                nearby_threat_count) using the coalition threat picture. Used by
                escort AI so frigates prioritize endangered tankers.
            frigate_penalty_transforms: if provided, penalize targets that have a
                frigate within SPEEDBOAT_FRIGATE_PROXIMITY. Used by speedboat AI
                to avoid escorted tankers.
        """
        old_target = bot.target_entity
        best_score = -1.0
        best_ent = 0
        best_tf: Transform | None = None

        for t_ent, (t_tf, t_faction, t_health) in esper.get_components(
            Transform, Faction, Health
        ):
            if t_health.hp <= 0 or t_faction.name not in factions:
                continue
            dx = t_tf.x - tf.x
            dy = t_tf.y - tf.y
            d_sq = dx * dx + dy * dy
            if d_sq > max_range_sq:
                continue
            d_sq = max(d_sq, 1.0)
            dist_term = math.sqrt(d_sq) if use_linear_distance else d_sq
            # Pressure: how many other drones/escorts are already targeting this entity
            pressure = drone_target_counts.get(t_ent, 0)
            score = 1.0 / (dist_term * (1 + pressure) ** pressure_power)
            # Threat boost: tankers with nearby enemies score higher
            if threat_boost:
                nearby = get_threats_near(t_tf.x, t_tf.y, ESCORT_THREAT_RADIUS_SQ)
                score *= 1.0 + ESCORT_THREAT_WEIGHT * len(nearby)
            # Frigate penalty: tankers near a frigate are much less attractive
            if frigate_penalty_transforms is not None:
                for f_tf in frigate_penalty_transforms:
                    fx = f_tf.x - t_tf.x
                    fy = f_tf.y - t_tf.y
                    if fx * fx + fy * fy < SPEEDBOAT_FRIGATE_PROXIMITY_SQ:
                        score *= 0.05
                        break
            # Stickiness: current target gets a bonus to prevent oscillation
            if t_ent == bot.target_entity:
                score *= 1.0 + TARGET_STICKINESS
            if score > best_score:
                best_score = score
                best_ent = t_ent
                best_tf = t_tf

        # Update pressure counts live
        if old_target != best_ent:
            if old_target != 0:
                drone_target_counts[old_target] = (
                    drone_target_counts.get(old_target, 1) - 1
                )
            if best_ent != 0:
                drone_target_counts[best_ent] = (
                    drone_target_counts.get(best_ent, 0) + 1
                )

        bot.target_entity = best_ent
        return best_tf

    @staticmethod
    def _pick_patrol_anchor(
        tf: Transform,
        frigate_transforms: list[Transform],
    ) -> tuple[float, float]:
        """Pick the patrol anchor (lane endpoint) with fewest nearby frigates."""
        best_anchor = PATROL_ANCHORS[0]
        best_pressure = float("inf")

        for anchor in PATROL_ANCHORS:
            # Count frigates closer to this anchor than to any other
            count = 0
            for f_tf in frigate_transforms:
                if f_tf is tf:
                    continue
                fd_sq = (f_tf.x - anchor[0]) ** 2 + (f_tf.y - anchor[1]) ** 2
                closer_to_other = False
                for other in PATROL_ANCHORS:
                    if other is anchor:
                        continue
                    od_sq = (f_tf.x - other[0]) ** 2 + (f_tf.y - other[1]) ** 2
                    if od_sq < fd_sq:
                        closer_to_other = True
                        break
                if not closer_to_other:
                    count += 1
            # Tiebreak: prefer the anchor closer to this frigate
            d_sq = (tf.x - anchor[0]) ** 2 + (tf.y - anchor[1]) ** 2
            # Small distance bias so equal-pressure anchors prefer the nearer one
            pressure = count + d_sq * 1e-12
            if pressure < best_pressure:
                best_pressure = pressure
                best_anchor = anchor

        return best_anchor

    @staticmethod
    def _drone_repulsion(
        ent: int,
        tf: Transform,
        swarm: list[tuple[int, Transform]],
        repel_range_sq: float,
        repel_range: float,
    ) -> float:
        """Return rudder adjustment from repulsion by nearby same-type drones."""
        rudder_adjust = 0.0
        for other_ent, other_tf in swarm:
            if other_ent == ent:
                continue
            dx = other_tf.x - tf.x
            dy = other_tf.y - tf.y
            d_sq = dx * dx + dy * dy
            if d_sq > repel_range_sq or d_sq < 1.0:
                continue
            dist = math.sqrt(d_sq)
            strength = (1.0 - dist / repel_range) * DRONE_REPEL_WEIGHT
            rudder_adjust -= steer_toward(tf, other_tf.x, other_tf.y) * strength
        return rudder_adjust

    def _shahed_ai(
        self,
        ent: int,
        tf: Transform,
        bot: BotControl,
        frigate_transforms: list[Transform],
        shahed_swarm: list[tuple[int, Transform]],
        drone_target_counts: dict[int, int],
    ) -> None:
        # Check if jammed by a nearby frigate
        jammed = False
        for f_tf in frigate_transforms:
            dx = f_tf.x - tf.x
            dy = f_tf.y - tf.y
            if dx * dx + dy * dy < JAM_RADIUS_SQ:
                jammed = True
                break

        if jammed:
            bot.rudder = 0.0
            bot.throttle = 1.0
            return

        # Pick target using pressure scoring (re-evaluated every tick)
        target_tf = self._pick_drone_target(
            tf, bot, ("civilian",), float("inf"), drone_target_counts
        )

        rudder = 0.0
        if target_tf is not None:
            rudder = steer_toward(tf, target_tf.x, target_tf.y)

        # Drone-drone repulsion
        rudder += self._drone_repulsion(
            ent, tf, shahed_swarm,
            DRONE_REPEL_RANGE_SHAHED_SQ, DRONE_REPEL_RANGE_SHAHED,
        )

        bot.rudder = max(-1.0, min(1.0, rudder))
        bot.throttle = 1.0

    def _quadcopter_ai(
        self,
        ent: int,
        tf: Transform,
        bot: BotControl,
        quad_swarm: list[tuple[int, Transform]],
        drone_target_counts: dict[int, int],
    ) -> None:
        # Pick target using pressure scoring (re-evaluated every tick)
        target_tf = self._pick_drone_target(
            tf, bot, ("civilian", "us"), QUADCOPTER_VISUAL_RANGE_SQ,
            drone_target_counts,
        )

        if target_tf is not None:
            rudder = steer_toward(tf, target_tf.x, target_tf.y)
        else:
            rudder = steer_toward(tf, STRAIT_CENTER[0], STRAIT_CENTER[1])

        # Drone-drone repulsion
        rudder += self._drone_repulsion(
            ent, tf, quad_swarm,
            DRONE_REPEL_RANGE_QUAD_SQ, DRONE_REPEL_RANGE_QUAD,
        )

        bot.rudder = max(-1.0, min(1.0, rudder))
        bot.throttle = 1.0

    # ------------------------------------------------------------------
    # Collision avoidance (unchanged)
    # ------------------------------------------------------------------

    def _apply_avoidance(
        self,
        ent: int,
        tf: Transform,
        bot: BotControl,
        phys: VehiclePhysics,
        faction_name: str,
        ships: list[tuple[int, Transform, VehiclePhysics, str]],
    ) -> None:
        best_rudder = bot.rudder
        best_throttle = bot.throttle

        vessel_rudder = self._calc_vessel_avoidance(ent, tf, phys, faction_name, ships)
        if vessel_rudder is not None:
            best_rudder = max(-1.0, min(1.0, bot.rudder + vessel_rudder))
            best_throttle = bot.throttle

        land_result = self._calc_land_avoidance(tf, phys)
        if land_result is not None:
            land_rudder, land_throttle_mult = land_result
            best_rudder = land_rudder
            best_throttle *= land_throttle_mult

        zone_result = self._calc_exclusion_zone_steering(ent, tf, bot)
        if zone_result is not None:
            zone_rudder, zone_strength = zone_result
            best_rudder = best_rudder * (1.0 - zone_strength) + zone_rudder * zone_strength
            best_throttle = max(bot.throttle, 0.5 * zone_strength)
        bot.rudder = best_rudder
        bot.throttle = best_throttle

    @staticmethod
    def _calc_vessel_avoidance(
        ent: int,
        tf: Transform,
        phys: VehiclePhysics,
        faction_name: str,
        ships: list[tuple[int, Transform, VehiclePhysics, str]],
    ) -> float | None:
        cos_h = math.cos(tf.heading)
        sin_h = math.sin(tf.heading)
        size = phys.size
        rudder_adjust = 0.0

        for other_ent, other_tf, other_phys, other_faction in ships:
            if other_ent == ent or other_faction != faction_name:
                continue
            dx = other_tf.x - tf.x
            dy = other_tf.y - tf.y
            min_dist = (size + other_phys.size) * AVOID_VESSEL_FACTOR
            dist_sq = dx * dx + dy * dy
            if dist_sq > min_dist * min_dist:
                continue
            dot = dx * cos_h + dy * sin_h
            if dot <= 0:
                continue
            cross = cos_h * dy - sin_h * dx
            dist = math.sqrt(dist_sq)
            strength = (1.0 - dist / min_dist) * AVOID_VESSEL_STRENGTH
            if cross >= 0:
                rudder_adjust -= strength
            else:
                rudder_adjust += strength

        return rudder_adjust if rudder_adjust != 0.0 else None

    @staticmethod
    def _calc_exclusion_zone_steering(
        ent: int, tf: Transform, bot: BotControl
    ) -> tuple[float, float] | None:
        for zone in EXCLUSION_ZONES:
            if bot.behavior not in zone["behaviors"]:
                continue
            polygon = zone["polygon"]
            inside = _point_in_polygon(tf.x, tf.y, polygon)
            if not inside:
                dist = _dist_to_polygon_edge(tf.x, tf.y, polygon)
                if dist >= EXCLUSION_BUFFER:
                    continue
                strength = 0.5 * (1.0 - dist / EXCLUSION_BUFFER)
            else:
                strength = 1.0

            # For tankers following waypoints, steer toward their current
            # route waypoint instead of STRAIT_CENTER. This prevents the
            # exclusion zone from steering tankers onto the wrong lane
            # when the alt lanes run close to the southern coast.
            target_x, target_y = STRAIT_CENTER[0], STRAIT_CENTER[1]
            if bot.behavior == "tanker_transit":
                cargo = esper.try_component(ent, CargoState)
                destination = cargo.destination if cargo else "oman"
                route, exit_point = _ROUTE_CONFIG.get(destination, _ROUTE_CONFIG["oman"])
                if bot.waypoint_index < len(route):
                    target_x, target_y = route[bot.waypoint_index]
                else:
                    target_x, target_y = exit_point[0], exit_point[1]

            wp = _find_lane_waypoint(tf.x, tf.y, target_x, target_y)
            if wp is not None:
                rudder = steer_toward(tf, wp[0], wp[1])
            else:
                rudder = steer_toward(tf, target_x, target_y)
            return rudder, strength
        return None

    @staticmethod
    def _calc_land_avoidance(
        tf: Transform, phys: VehiclePhysics
    ) -> tuple[float, float] | None:
        size = phys.size
        probe_dist = min(size * 10.0 + abs(tf.speed) * 8.0, 1500.0)
        land_score = 0.0
        forward_blocked = False

        for angle_offset in _LAND_PROBE_ANGLES:
            probe_angle = tf.heading + angle_offset
            px = tf.x + math.cos(probe_angle) * probe_dist
            py = tf.y + math.sin(probe_angle) * probe_dist
            if is_land(px, py):
                if abs(angle_offset) < 0.1:
                    forward_blocked = True
                elif angle_offset > 0:
                    land_score += 1.0
                else:
                    land_score -= 1.0

        rudder = None
        if land_score > 0:
            rudder = -AVOID_LAND_STRENGTH
        elif land_score < 0:
            rudder = AVOID_LAND_STRENGTH
        elif forward_blocked:
            left_clear = not is_land(
                tf.x + math.cos(tf.heading - math.pi / 3) * probe_dist,
                tf.y + math.sin(tf.heading - math.pi / 3) * probe_dist,
            )
            rudder = -AVOID_LAND_STRENGTH if left_clear else AVOID_LAND_STRENGTH

        if rudder is not None:
            return rudder, 0.3 if forward_blocked else 1.0
        return None
