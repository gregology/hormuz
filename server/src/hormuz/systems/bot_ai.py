"""Bot AI processor — tanker waypoint following, shahed interception."""

import math

import esper

from hormuz.components import BotControl, Faction, Health, Transform
from hormuz.map_data import LANE_OUTBOUND, TANKER_EXITS


def steer_toward(tf: Transform, target_x: float, target_y: float) -> float:
    """Return rudder value (-1 to 1) to steer toward a target point."""
    desired = math.atan2(target_y - tf.y, target_x - tf.x)
    diff = desired - tf.heading
    # Normalize to [-pi, pi]
    diff = (diff + math.pi) % (2 * math.pi) - math.pi
    return max(-1.0, min(1.0, diff * 2.0))


# Tankers spawned at western ports (index 0-2) go east via LANE_OUTBOUND.
# Tanker spawned at Gulf of Oman (index 3) goes west via reversed LANE_INBOUND.
# Exit thresholds (squared distance).
WAYPOINT_ADVANCE_DIST_SQ = 500.0**2
EXIT_DIST_SQ = 1500.0**2


class BotAIProcessor(esper.Processor):
    def process(self, dt: float = 0.05) -> None:
        for ent, (tf, bot) in esper.get_components(Transform, BotControl):
            if bot.behavior == "tanker_transit":
                self._tanker_ai(tf, bot)
            elif bot.behavior == "shahed_intercept":
                self._shahed_ai(ent, tf, bot)

    def _tanker_ai(self, tf: Transform, bot: BotControl) -> None:
        route = LANE_OUTBOUND
        exit_point = TANKER_EXITS[0]  # Gulf of Oman exit

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
            # Past last waypoint, head for exit
            bot.rudder = steer_toward(tf, exit_point[0], exit_point[1])

        bot.throttle = 1.0

    def _shahed_ai(self, ent: int, tf: Transform, bot: BotControl) -> None:
        best_dist_sq = float("inf")
        best_tf: Transform | None = None

        for t_ent, (t_tf, t_faction, t_health) in esper.get_components(Transform, Faction, Health):
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

        bot.throttle = 1.0
