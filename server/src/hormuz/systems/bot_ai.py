"""Bot AI processor — tanker waypoint following, shahed interception, frigate escort."""

import math
from typing import Callable

import esper

from hormuz.components import BotControl, CargoState, Faction, Health, Transform, VehiclePhysics
from hormuz.generated.terrain_grid import is_land
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

# Quadcopter visual detection range — FPV camera, better optics than shahed
QUADCOPTER_VISUAL_RANGE = 8000.0
QUADCOPTER_VISUAL_RANGE_SQ = QUADCOPTER_VISUAL_RANGE * QUADCOPTER_VISUAL_RANGE

# Frigate escort zone — outside these bounds, tankers are considered safe
ESCORT_ZONE_WEST = 50000.0
ESCORT_ZONE_EAST = 110000.0

# Follow-escort-lead: max distance to latch onto an escort_lead
FOLLOW_ESCORT_RANGE = 250.0
FOLLOW_ESCORT_RANGE_SQ = FOLLOW_ESCORT_RANGE * FOLLOW_ESCORT_RANGE

# QRF (Quick Reaction Force) patrol/engagement zones
QRF_PATROL_RADIUS = 2000.0
QRF_ENGAGE_RADIUS = 5000.0
QRF_ENGAGE_RADIUS_SQ = QRF_ENGAGE_RADIUS * QRF_ENGAGE_RADIUS
QRF_ZONES: dict[str, tuple[float, float]] = {
    "west_strait_qrf": (79612.0, 42615.0),
    "east_strait_qrf": (91909.0, 48418.0),
}

# escort_follow: range to detect and follow an escort_lead
ESCORT_FOLLOW_RANGE = 100.0
ESCORT_FOLLOW_RANGE_SQ = ESCORT_FOLLOW_RANGE * ESCORT_FOLLOW_RANGE
ESCORT_FOLLOW_DIST = 100.0  # desired following distance

# --- Collision avoidance constants ---
# Friendly vessel: avoidance radius = (our_size + their_size) * this factor
AVOID_VESSEL_FACTOR = 0.8
AVOID_VESSEL_STRENGTH = 0.5  # max rudder adjustment from vessel avoidance

# Land: probe angles relative to heading (radians), ~0°, ±20°, ±40°
_LAND_PROBE_ANGLES = (0.0, -0.35, 0.35, -0.7, 0.7)
AVOID_LAND_STRENGTH = 0.8  # max rudder adjustment from land avoidance


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


# ---------------------------------------------------------------------------
# Shared context collected once per tick for behavior functions
# ---------------------------------------------------------------------------


class _TickContext:
    """Pre-collected data shared across all behavior functions in a single tick."""

    __slots__ = ("frigate_transforms", "escort_leads")

    def __init__(self) -> None:
        self.frigate_transforms: list[Transform] = []
        self.escort_leads: list[Transform] = []


# Type alias for behavior functions
BehaviorFn = Callable[[int, Transform, BotControl, _TickContext], None]


# ---------------------------------------------------------------------------
# Behavior functions
# ---------------------------------------------------------------------------


def _tanker_ai(ent: int, tf: Transform, bot: BotControl, ctx: _TickContext) -> None:
    cargo = esper.try_component(ent, CargoState)
    destination = cargo.destination if cargo else "oman"
    bot.throttle, bot.rudder, bot.waypoint_index = run_tanker_ai(
        tf, bot.waypoint_index, destination
    )


def _follow_escort_lead_ai(
    ent: int, tf: Transform, bot: BotControl, ctx: _TickContext
) -> None:
    """Follow a nearby escort_lead that is ahead in the direction of travel."""
    cargo = esper.try_component(ent, CargoState)
    destination = cargo.destination if cargo else "oman"
    outbound = destination == "oman"

    # Find nearest escort_lead that is ahead and within range
    best_lead: Transform | None = None
    best_dist_sq = FOLLOW_ESCORT_RANGE_SQ

    for lead_tf in ctx.escort_leads:
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
        # Follow the escort — steer toward it and match its speed
        bot.rudder = steer_toward(tf, best_lead.x, best_lead.y)
        dist = math.sqrt(best_dist_sq)
        # Slow down when close, speed up when falling behind
        if dist < 50.0:
            bot.throttle = 0.6
        elif dist < 150.0:
            bot.throttle = 0.8
        else:
            bot.throttle = 1.0
    else:
        # No escort_lead nearby — fall back to normal tanker waypoint following
        bot.throttle, bot.rudder, bot.waypoint_index = run_tanker_ai(
            tf, bot.waypoint_index, destination
        )


def _shahed_ai(ent: int, tf: Transform, bot: BotControl, ctx: _TickContext) -> None:
    # Check if jammed by a nearby frigate
    jammed = False
    for f_tf in ctx.frigate_transforms:
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


def _quadcopter_ai(ent: int, tf: Transform, bot: BotControl, ctx: _TickContext) -> None:
    # Quadcopters are autonomous (not jammed by RF) and target both civilians and US forces
    best_dist_sq = QUADCOPTER_VISUAL_RANGE_SQ
    best_tf: Transform | None = None

    for t_ent, (t_tf, t_faction, t_health) in esper.get_components(
        Transform, Faction, Health
    ):
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


def _escort_ai(ent: int, tf: Transform, bot: BotControl, ctx: _TickContext) -> None:
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


def _escort_lead_ai(ent: int, tf: Transform, bot: BotControl, ctx: _TickContext) -> None:
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

    bot.throttle = 0.55


def _escort_follow_ai(
    ent: int, tf: Transform, bot: BotControl, ctx: _TickContext
) -> None:
    """Like escort, but follows a nearby escort_lead frigate when within range."""
    # Check for nearby escort_lead to follow
    best_lead: Transform | None = None
    best_dist_sq = ESCORT_FOLLOW_RANGE_SQ

    for lead_tf in ctx.escort_leads:
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
            bot.throttle = 0.3
        elif dist < ESCORT_FOLLOW_DIST * 0.8:
            bot.throttle = 0.6
        else:
            bot.throttle = 1.0
    else:
        # No escort_lead nearby — fall back to normal escort behavior
        _escort_ai(ent, tf, bot, ctx)


def _qrf_ai(
    ent: int,
    tf: Transform,
    bot: BotControl,
    ctx: _TickContext,
    zone_center: tuple[float, float],
) -> None:
    """Patrol around a fixed point; engage any enemy that enters the zone."""
    cx, cy = zone_center

    # Check for enemies within engagement radius of the zone center
    best_dist_sq = QRF_ENGAGE_RADIUS_SQ
    best_tf: Transform | None = None
    for _, (t_tf, t_faction, t_health) in esper.get_components(Transform, Faction, Health):
        if t_health.hp <= 0 or t_faction.name in ("us", "civilian"):
            continue
        dx = t_tf.x - cx
        dy = t_tf.y - cy
        d_sq = dx * dx + dy * dy
        if d_sq < best_dist_sq:
            best_dist_sq = d_sq
            best_tf = t_tf

    if best_tf is not None:
        # Engage — head toward enemy
        bot.rudder = steer_toward(tf, best_tf.x, best_tf.y)
        bot.throttle = 1.0
        return

    # No threat — orbit patrol zone
    dx = tf.x - cx
    dy = tf.y - cy
    dist = math.sqrt(dx * dx + dy * dy)

    if dist > QRF_PATROL_RADIUS * 2:
        # Far from zone — head back
        bot.rudder = steer_toward(tf, cx, cy)
        bot.throttle = 1.0
    else:
        # Orbit clockwise around zone center
        angle = math.atan2(dy, dx)
        orbit_angle = angle + 0.5
        orbit_x = cx + math.cos(orbit_angle) * QRF_PATROL_RADIUS
        orbit_y = cy + math.sin(orbit_angle) * QRF_PATROL_RADIUS
        bot.rudder = steer_toward(tf, orbit_x, orbit_y)

        if dist > QRF_PATROL_RADIUS * 1.3:
            bot.throttle = 1.0
        elif dist < QRF_PATROL_RADIUS * 0.7:
            bot.throttle = 0.3
        else:
            bot.throttle = 0.7


# ---------------------------------------------------------------------------
# Behavior registry — maps behavior name to handler function
# ---------------------------------------------------------------------------

_BEHAVIOR_REGISTRY: dict[str, BehaviorFn] = {
    "tanker_transit": _tanker_ai,
    "follow_escort_lead": _follow_escort_lead_ai,
    "shahed_intercept": _shahed_ai,
    "quadcopter_intercept": _quadcopter_ai,
    "escort": _escort_ai,
    "escort_follow": _escort_follow_ai,
    "escort_lead": _escort_lead_ai,
}


class BotAIProcessor(esper.Processor):
    def process(self, dt: float = 0.05) -> None:
        # Build shared context for this tick
        ctx = _TickContext()

        for _, (tf, phys, health) in esper.get_components(Transform, VehiclePhysics, Health):
            if phys.vehicle_type == "frigate" and health.hp > 0:
                ctx.frigate_transforms.append(tf)

        for _, (tf, bot) in esper.get_components(Transform, BotControl):
            if bot.behavior == "escort_lead":
                ctx.escort_leads.append(tf)

        # Behavior dispatch via registry
        for ent, (tf, bot) in esper.get_components(Transform, BotControl):
            handler = _BEHAVIOR_REGISTRY.get(bot.behavior)
            if handler is not None:
                handler(ent, tf, bot, ctx)
            elif bot.behavior in QRF_ZONES:
                _qrf_ai(ent, tf, bot, ctx, QRF_ZONES[bot.behavior])

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
                _apply_avoidance(ent, tf, bot, phys, faction.name, ships)


def _apply_avoidance(
    ent: int,
    tf: Transform,
    bot: BotControl,
    phys: VehiclePhysics,
    faction_name: str,
    ships: list[tuple[int, Transform, VehiclePhysics, str]],
) -> None:
    """Adjust rudder/throttle to avoid friendly vessels and land."""
    cos_h = math.cos(tf.heading)
    sin_h = math.sin(tf.heading)
    size = phys.size
    rudder_adjust = 0.0

    # --- Friendly vessel avoidance ---
    for other_ent, other_tf, other_phys, other_faction in ships:
        if other_ent == ent or other_faction != faction_name:
            continue

        dx = other_tf.x - tf.x
        dy = other_tf.y - tf.y
        min_dist = (size + other_phys.size) * AVOID_VESSEL_FACTOR
        dist_sq = dx * dx + dy * dy
        if dist_sq > min_dist * min_dist:
            continue

        # Only avoid vessels ahead of us (dot product with heading > 0)
        dot = dx * cos_h + dy * sin_h
        if dot <= 0:
            continue

        # Cross product determines which side: positive = to the right
        cross = cos_h * dy - sin_h * dx
        dist = math.sqrt(dist_sq)
        strength = (1.0 - dist / min_dist) * AVOID_VESSEL_STRENGTH

        if cross >= 0:
            rudder_adjust -= strength  # other is right, steer left
        else:
            rudder_adjust += strength  # other is left, steer right

    # --- Land avoidance ---
    probe_dist = size * 3.0 + abs(tf.speed) * 3.0
    land_score = 0.0  # positive = more land to the right, steer left
    forward_blocked = False

    for angle_offset in _LAND_PROBE_ANGLES:
        probe_angle = tf.heading + angle_offset
        px = tf.x + math.cos(probe_angle) * probe_dist
        py = tf.y + math.sin(probe_angle) * probe_dist
        if is_land(px, py):
            if abs(angle_offset) < 0.1:
                forward_blocked = True
            elif angle_offset > 0:
                land_score += 1.0  # land to the right
            else:
                land_score -= 1.0  # land to the left

    if forward_blocked or land_score != 0.0:
        if land_score > 0:
            rudder_adjust -= AVOID_LAND_STRENGTH  # land right, steer left
        elif land_score < 0:
            rudder_adjust += AVOID_LAND_STRENGTH  # land left, steer right
        elif forward_blocked:
            # Land dead ahead, both sides equally blocked — probe wider to break tie
            left_clear = not is_land(
                tf.x + math.cos(tf.heading - math.pi / 3) * probe_dist,
                tf.y + math.sin(tf.heading - math.pi / 3) * probe_dist,
            )
            if left_clear:
                rudder_adjust -= AVOID_LAND_STRENGTH
            else:
                rudder_adjust += AVOID_LAND_STRENGTH

        if forward_blocked:
            bot.throttle *= 0.5

    # Apply combined adjustment
    if rudder_adjust != 0.0:
        bot.rudder = max(-1.0, min(1.0, bot.rudder + rudder_adjust))
