"""Bot AI processor — tanker waypoint following, shahed interception, frigate escort."""

import math

import esper

from hormuz.components import BotControl, CargoState, Faction, Health, Transform, VehiclePhysics
from hormuz.generated.map_data import EXCLUSION_ZONES
from hormuz.generated.terrain_grid import is_land
from hormuz.map_data import (
    ESCORT_ZONE_EAST,
    ESCORT_ZONE_WEST,
    GULF_DESTINATION,
    LANE_INBOUND,
    LANE_OUTBOUND,
    OMAN_DESTINATION,
    QRF_PATROL_ROUTES,
    STRAIT_CENTER,
)
from hormuz.systems.combat import JAM_RADIUS_SQ

ESCORT_RADIUS = 500.0  # desired orbit distance from escorted tanker

# Shahed visual detection range — no radar, must see targets visually
SHAHED_VISUAL_RANGE = 5000.0
SHAHED_VISUAL_RANGE_SQ = SHAHED_VISUAL_RANGE * SHAHED_VISUAL_RANGE

# Quadcopter visual detection range — FPV camera, better optics than shahed
QUADCOPTER_VISUAL_RANGE = 8000.0
QUADCOPTER_VISUAL_RANGE_SQ = QUADCOPTER_VISUAL_RANGE * QUADCOPTER_VISUAL_RANGE

# Follow-escort-lead: max distance to latch onto an escort_lead (matches autocannon range)
FOLLOW_ESCORT_RANGE = 1500.0
FOLLOW_ESCORT_RANGE_SQ = FOLLOW_ESCORT_RANGE * FOLLOW_ESCORT_RANGE

# QRF (Quick Reaction Force) patrol constants
QRF_ENGAGE_RADIUS = 5000.0
QRF_ENGAGE_RADIUS_SQ = QRF_ENGAGE_RADIUS * QRF_ENGAGE_RADIUS
QRF_WAYPOINT_DIST_SQ = 1000.0**2

# escort_follow: range to detect and follow an escort_lead
ESCORT_FOLLOW_RANGE = 1500.0
ESCORT_FOLLOW_RANGE_SQ = ESCORT_FOLLOW_RANGE * ESCORT_FOLLOW_RANGE
ESCORT_FOLLOW_DIST = 800.0  # desired following distance — behind the tanker cluster

# --- Collision avoidance constants ---
# Friendly vessel: avoidance radius = (our_size + their_size) * this factor
AVOID_VESSEL_FACTOR = 0.8
AVOID_VESSEL_STRENGTH = 0.5  # max rudder adjustment from vessel avoidance

# Land: probe angles relative to heading (radians), ~0°, ±20°, ±40°, ±60°
_LAND_PROBE_ANGLES = (0.0, -0.35, 0.35, -0.7, 0.7, -1.05, 1.05)
AVOID_LAND_STRENGTH = 0.8  # max rudder adjustment from land avoidance

# Exclusion zone buffer — steering starts this many units outside the polygon
EXCLUSION_BUFFER = 2000.0

# Transit: use shipping lane waypoints when further than this from target.
# Kept low enough that frigates north of Qeshm still use lane nav to return south.
TRANSIT_DIST_SQ = 5000.0**2


def steer_toward(tf: Transform, target_x: float, target_y: float) -> float:
    """Return rudder value (-1 to 1) to steer toward a target point."""
    desired = math.atan2(target_y - tf.y, target_x - tf.x)
    diff = desired - tf.heading
    # Normalize to [-pi, pi]
    diff = (diff + math.pi) % (2 * math.pi) - math.pi
    return max(-1.0, min(1.0, diff * 2.0))


def _find_lane_waypoint(
    tf_x: float, tf_y: float, target_x: float, target_y: float
) -> tuple[float, float] | None:
    """Return nearest shipping lane waypoint that makes progress toward the target."""
    going_west = target_x < tf_x
    lane = LANE_INBOUND if going_west else LANE_OUTBOUND
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


WAYPOINT_ADVANCE_DIST_SQ = 500.0**2
EXIT_DIST_SQ = 1500.0**2

# Route/destination lookup by cargo destination
_ROUTE_CONFIG = {
    "oman": (LANE_OUTBOUND, OMAN_DESTINATION["position"]),
    "gulf": (LANE_INBOUND, GULF_DESTINATION["position"]),
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

        # Collect escort_lead positions + headings for follow_escort_lead tankers
        escort_leads: list[Transform] = []
        for _, (tf, bot) in esper.get_components(Transform, BotControl):
            if bot.behavior == "escort_lead":
                escort_leads.append(tf)

        # Behavior dispatch
        for ent, (tf, bot) in esper.get_components(Transform, BotControl):
            if bot.behavior == "tanker_transit":
                self._tanker_ai(ent, tf, bot)
            elif bot.behavior == "follow_escort_lead":
                self._follow_escort_lead_ai(ent, tf, bot, escort_leads)
            elif bot.behavior == "shahed_intercept":
                self._shahed_ai(ent, tf, bot, frigate_transforms)
            elif bot.behavior == "quadcopter_intercept":
                self._quadcopter_ai(ent, tf, bot)
            elif bot.behavior == "escort":
                self._escort_ai(ent, tf, bot)
            elif bot.behavior == "escort_follow":
                self._escort_follow_ai(ent, tf, bot, escort_leads)
            elif bot.behavior == "escort_lead":
                self._escort_lead_ai(ent, tf, bot)
            elif bot.behavior in QRF_PATROL_ROUTES:
                self._qrf_ai(ent, tf, bot, QRF_PATROL_ROUTES[bot.behavior])

        # --- Collision avoidance post-processing ---
        # Collect all alive non-airborne ships (bot + player) for vessel avoidance
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

    def _quadcopter_ai(self, ent: int, tf: Transform, bot: BotControl) -> None:
        # Quadcopters are autonomous (not jammed by RF) and target both civilians and US forces
        best_dist_sq = QUADCOPTER_VISUAL_RANGE_SQ
        best_tf: Transform | None = None

        for t_ent, (t_tf, t_faction, t_health) in esper.get_components(Transform, Faction, Health):
            if t_health.hp <= 0:
                continue
            if t_faction.name not in ("civilian", "us"):
                continue
            dx = t_tf.x - tf.x
            dy = t_tf.y - tf.y
            d_sq = dx * dx + dy * dy
            if d_sq < best_dist_sq:
                best_dist_sq = d_sq
                best_tf = t_tf

        if best_tf is not None:
            bot.rudder = steer_toward(tf, best_tf.x, best_tf.y)
        else:
            # No target — head toward strait center
            bot.rudder = steer_toward(tf, STRAIT_CENTER[0], STRAIT_CENTER[1])

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
            dx = STRAIT_CENTER[0] - tf.x
            dy = STRAIT_CENTER[1] - tf.y
            if dx * dx + dy * dy > TRANSIT_DIST_SQ:
                wp = _find_lane_waypoint(tf.x, tf.y, STRAIT_CENTER[0], STRAIT_CENTER[1])
                if wp is not None:
                    bot.rudder = steer_toward(tf, wp[0], wp[1])
                else:
                    bot.rudder = steer_toward(tf, STRAIT_CENTER[0], STRAIT_CENTER[1])
            else:
                bot.rudder = steer_toward(tf, STRAIT_CENTER[0], STRAIT_CENTER[1])
            bot.throttle = 0.7
            return

        target_tf = esper.component_for_entity(bot.target_entity, Transform)
        dx = target_tf.x - tf.x
        dy = target_tf.y - tf.y
        dist = math.sqrt(dx * dx + dy * dy)

        if dist > ESCORT_RADIUS * 2:
            # Far from tanker — use lane waypoints to avoid crossing islands
            wp = _find_lane_waypoint(tf.x, tf.y, target_tf.x, target_tf.y)
            if wp is not None:
                bot.rudder = steer_toward(tf, wp[0], wp[1])
            else:
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

    def _escort_lead_ai(self, ent: int, tf: Transform, bot: BotControl) -> None:
        """Sweep back and forth along shipping lanes at 80% throttle."""
        cargo = esper.try_component(ent, CargoState)
        # Use CargoState.destination to track current direction; default outbound
        if cargo is None:
            esper.add_component(ent, CargoState(loaded=False, destination="oman"))
            cargo = esper.component_for_entity(ent, CargoState)

        route, exit_point = _ROUTE_CONFIG.get(cargo.destination, _ROUTE_CONFIG["oman"])

        if bot.waypoint_index < len(route):
            wx, wy = route[bot.waypoint_index]
            dx = wx - tf.x
            dy = wy - tf.y
            if dx * dx + dy * dy < WAYPOINT_ADVANCE_DIST_SQ:
                bot.waypoint_index += 1

        if bot.waypoint_index < len(route):
            wx, wy = route[bot.waypoint_index]
            bot.rudder = steer_toward(tf, wx, wy)
        else:
            # Reached the end — reverse direction
            if cargo.destination == "oman":
                cargo.destination = "gulf"
            else:
                cargo.destination = "oman"
            bot.waypoint_index = 0
            route, _ = _ROUTE_CONFIG[cargo.destination]
            wx, wy = route[0]
            bot.rudder = steer_toward(tf, wx, wy)

        # Slow down to let tankers catch up if fewer than 3 are within autocannon range behind
        cos_h = math.cos(tf.heading)
        sin_h = math.sin(tf.heading)
        behind_count = 0
        for _, (t_tf, t_phys, t_health) in esper.get_components(Transform, VehiclePhysics, Health):
            if t_phys.vehicle_type != "oil_tanker" or t_health.hp <= 0:
                continue
            dx = t_tf.x - tf.x
            dy = t_tf.y - tf.y
            if dx * dx + dy * dy > FOLLOW_ESCORT_RANGE_SQ:
                continue
            if dx * cos_h + dy * sin_h < 0:
                behind_count += 1

        bot.throttle = 0.5 if behind_count >= 3 else 0.1

    def _follow_escort_lead_ai(
        self,
        ent: int,
        tf: Transform,
        bot: BotControl,
        escort_leads: list[Transform],
    ) -> None:
        """Follow a nearby escort_lead that is ahead in the direction of travel."""
        cargo = esper.try_component(ent, CargoState)
        destination = cargo.destination if cargo else "oman"
        outbound = destination == "oman"

        # Find nearest escort_lead that is ahead and within range
        best_lead: Transform | None = None
        best_dist_sq = FOLLOW_ESCORT_RANGE_SQ

        for lead_tf in escort_leads:
            # "Ahead" means further east if outbound, further west if inbound
            if outbound and lead_tf.x <= tf.x:
                continue
            if not outbound and lead_tf.x >= tf.x:
                continue

            dx = lead_tf.x - tf.x
            dy = lead_tf.y - tf.y
            d_sq = dx * dx + dy * dy
            if d_sq < best_dist_sq:
                best_dist_sq = d_sq
                best_lead = lead_tf

        if best_lead is not None:
            # Follow the escort — steer toward it, adjust speed to stay close
            bot.rudder = steer_toward(tf, best_lead.x, best_lead.y)
            dist = math.sqrt(best_dist_sq)
            if dist < 300.0:
                bot.throttle = 0.75  # close — roughly match escort_lead speed
            elif dist < 700.0:
                bot.throttle = 0.85  # medium — close gap slowly
            else:
                bot.throttle = 1.0  # far — catch up
        else:
            # No escort_lead nearby — fall back to normal tanker waypoint following
            bot.throttle, bot.rudder, bot.waypoint_index = run_tanker_ai(
                tf, bot.waypoint_index, destination
            )

    def _qrf_ai(
        self,
        ent: int,
        tf: Transform,
        bot: BotControl,
        patrol_route: tuple[tuple[float, float], tuple[float, float]],
    ) -> None:
        """Patrol between two points; engage any enemy near the route."""
        # Check for enemies within engagement radius of either patrol point
        best_dist_sq = QRF_ENGAGE_RADIUS_SQ
        best_tf: Transform | None = None
        for _, (t_tf, t_faction, t_health) in esper.get_components(Transform, Faction, Health):
            if t_health.hp <= 0 or t_faction.name in ("us", "civilian"):
                continue
            for px, py in patrol_route:
                dx = t_tf.x - px
                dy = t_tf.y - py
                d_sq = dx * dx + dy * dy
                if d_sq < best_dist_sq:
                    best_dist_sq = d_sq
                    best_tf = t_tf

        if best_tf is not None:
            bot.rudder = steer_toward(tf, best_tf.x, best_tf.y)
            bot.throttle = 1.0
            return

        # Current patrol target — alternate between the two points
        tx, ty = patrol_route[bot.waypoint_index % 2]
        dx = tf.x - tx
        dy = tf.y - ty
        dist_sq = dx * dx + dy * dy

        if dist_sq < QRF_WAYPOINT_DIST_SQ:
            bot.waypoint_index = (bot.waypoint_index + 1) % 2
            tx, ty = patrol_route[bot.waypoint_index]

        # Navigate to current patrol target
        dx = tf.x - tx
        dy = tf.y - ty
        dist_sq = dx * dx + dy * dy

        if dist_sq > TRANSIT_DIST_SQ:
            # Far from patrol area — follow shipping lanes
            wp = _find_lane_waypoint(tf.x, tf.y, tx, ty)
            if wp is not None:
                bot.rudder = steer_toward(tf, wp[0], wp[1])
            else:
                bot.rudder = steer_toward(tf, tx, ty)
            bot.throttle = 1.0
        else:
            bot.rudder = steer_toward(tf, tx, ty)
            bot.throttle = 0.7

    def _escort_follow_ai(
        self,
        ent: int,
        tf: Transform,
        bot: BotControl,
        escort_leads: list[Transform],
    ) -> None:
        """Like escort, but follows a nearby escort_lead frigate when within range."""
        # Check for nearby escort_lead to follow
        best_lead: Transform | None = None
        best_dist_sq = ESCORT_FOLLOW_RANGE_SQ

        for lead_tf in escort_leads:
            dx = lead_tf.x - tf.x
            dy = lead_tf.y - tf.y
            d_sq = dx * dx + dy * dy
            if d_sq < best_dist_sq:
                best_dist_sq = d_sq
                best_lead = lead_tf

        if best_lead is not None:
            # Follow the escort_lead at the desired distance
            dist = math.sqrt(best_dist_sq)
            bot.rudder = steer_toward(tf, best_lead.x, best_lead.y)
            if dist < ESCORT_FOLLOW_DIST * 0.5:
                bot.throttle = 0.3  # too close — fall back
            elif dist < ESCORT_FOLLOW_DIST:
                bot.throttle = 0.5  # near desired distance — match lead speed
            else:
                bot.throttle = 1.0  # too far — catch up
        else:
            # No escort_lead nearby — fall back to normal escort behavior
            self._escort_ai(ent, tf, bot)

    def _apply_avoidance(
        self,
        ent: int,
        tf: Transform,
        bot: BotControl,
        phys: VehiclePhysics,
        faction_name: str,
        ships: list[tuple[int, Transform, VehiclePhysics, str]],
    ) -> None:
        """Layered steering: higher-priority concerns override lower ones.

        Priority levels (highest wins):
          3 — Exclusion zone escape (stay out of restricted areas)
          2 — Land avoidance (never run aground)
          1 — Vessel avoidance (don't collide with friendlies)
          0 — AI behavior (already set on bot.rudder/throttle before this runs)
        """
        best_rudder = bot.rudder
        best_throttle = bot.throttle
        best_priority = 0  # AI behavior baseline

        # --- Priority 1: Friendly vessel avoidance ---
        vessel_rudder = self._calc_vessel_avoidance(ent, tf, phys, faction_name, ships)
        if vessel_rudder is not None:
            best_rudder = max(-1.0, min(1.0, bot.rudder + vessel_rudder))
            best_throttle = bot.throttle
            best_priority = 1

        # --- Priority 2: Land avoidance ---
        land_result = self._calc_land_avoidance(tf, phys)
        if land_result is not None:
            land_rudder, land_throttle_mult = land_result
            if best_priority < 2:
                best_rudder = land_rudder
            else:
                best_rudder = land_rudder
            best_throttle *= land_throttle_mult
            best_priority = 2

        # --- Priority 3: Exclusion zones (with buffer) ---
        zone_result = self._calc_exclusion_zone_steering(tf, bot)
        if zone_result is not None:
            zone_rudder, zone_strength = zone_result
            # Blend: at strength 1.0 (deep inside), fully override. In the buffer,
            # interpolate between AI steering and zone steering.
            best_rudder = best_rudder * (1.0 - zone_strength) + zone_rudder * zone_strength
            best_throttle = max(bot.throttle, 0.5 * zone_strength)
            best_priority = 3

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
        """Return rudder adjustment for friendly vessel avoidance, or None."""
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
        tf: Transform, bot: BotControl
    ) -> tuple[float, float] | None:
        """Return (rudder, strength) if inside or near an exclusion zone, else None.

        strength is 0.0 at the outer edge of the buffer and 1.0 deep inside.
        """
        for zone in EXCLUSION_ZONES:
            if bot.behavior not in zone["behaviors"]:
                continue
            polygon = zone["polygon"]
            inside = _point_in_polygon(tf.x, tf.y, polygon)
            if not inside:
                dist = _dist_to_polygon_edge(tf.x, tf.y, polygon)
                if dist >= EXCLUSION_BUFFER:
                    continue
                # In the buffer zone — strength ramps from 0 at edge to ~0.5 at polygon boundary
                strength = 0.5 * (1.0 - dist / EXCLUSION_BUFFER)
            else:
                # Inside the polygon — full strength
                strength = 1.0

            # Steer toward shipping lane or strait center
            wp = _find_lane_waypoint(tf.x, tf.y, STRAIT_CENTER[0], STRAIT_CENTER[1])
            if wp is not None:
                rudder = steer_toward(tf, wp[0], wp[1])
            else:
                rudder = steer_toward(tf, STRAIT_CENTER[0], STRAIT_CENTER[1])
            return rudder, strength
        return None

    @staticmethod
    def _calc_land_avoidance(
        tf: Transform, phys: VehiclePhysics
    ) -> tuple[float, float] | None:
        """Return (rudder, throttle_multiplier) if land is detected, else None."""
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
