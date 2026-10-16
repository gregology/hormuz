"""How a player's input command drives their vehicle.

Mirrored by client/src/vehicles/controls.ts, which predicts the player's own
vehicle with it; shared/physics_fixtures.json pins the two together.
"""

from collections.abc import Callable

from hormuz.generated.vehicles import VEHICLE_PHYSICS

KEY_FORWARD = 0x01
KEY_REVERSE = 0x02
KEY_LEFT = 0x04
KEY_RIGHT = 0x08


# Shaheds lose steering to frigates' jammers; quadcopters fly autonomously through them.
JAMMABLE = frozenset({"shahed"})


def vehicle_controls(
    vehicle_type: str,
    keys: int,
    throttle_float: float,
    near_jammer: Callable[[], bool] = lambda: False,
) -> tuple[float, float]:
    """Throttle and rudder, each -1 to 1, for one command.

    `near_jammer` says whether a frigate's jammer reaches the vehicle. It
    searches the world, so it's only asked when jamming would matter.
    """
    rudder = (1.0 if keys & KEY_RIGHT else 0.0) - (1.0 if keys & KEY_LEFT else 0.0)
    if VEHICLE_PHYSICS[vehicle_type]["airborne"]:
        # Drones are hold-to-move; ships keep the throttle the player stepped to.
        throttle = (1.0 if keys & KEY_FORWARD else 0.0) - (1.0 if keys & KEY_REVERSE else 0.0)
    else:
        throttle = max(-1.0, min(1.0, throttle_float))
    if rudder != 0.0 and vehicle_type in JAMMABLE and near_jammer():
        rudder = 0.0
    return throttle, rudder
