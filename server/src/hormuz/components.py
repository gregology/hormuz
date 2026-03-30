"""ECS components for the Hormuz game server."""


class Transform:
    """Position and orientation in world space."""

    __slots__ = ("x", "y", "heading", "speed", "drift", "angular_velocity")

    def __init__(
        self,
        x: float,
        y: float,
        heading: float = 0.0,
        speed: float = 0.0,
        drift: float = 0.0,
        angular_velocity: float = 0.0,
    ) -> None:
        self.x = x
        self.y = y
        self.heading = heading
        self.speed = speed
        self.drift = drift
        self.angular_velocity = angular_velocity


class VehiclePhysics:
    """Physics parameters — immutable per vehicle type."""

    __slots__ = (
        "vehicle_type",
        "max_speed",
        "acceleration",
        "drag",
        "turn_rate",
        "drift_factor",
        "lateral_drag",
        "min_turn_fraction",
        "cruise_speed",
        "airborne",
        "size",
        "angular_drag",
    )

    def __init__(
        self,
        vehicle_type: str,
        max_speed: float,
        acceleration: float,
        drag: float,
        turn_rate: float,
        drift_factor: float,
        lateral_drag: float,
        min_turn_fraction: float = 0.0,
        cruise_speed: float = 0.0,
        airborne: bool = False,
        size: float = 10.0,
        angular_drag: float = 0.15,
    ) -> None:
        self.vehicle_type = vehicle_type
        self.max_speed = max_speed
        self.acceleration = acceleration
        self.drag = drag
        self.turn_rate = turn_rate
        self.drift_factor = drift_factor
        self.lateral_drag = lateral_drag
        self.min_turn_fraction = min_turn_fraction
        self.cruise_speed = cruise_speed
        self.airborne = airborne
        self.size = size
        self.angular_drag = angular_drag


class Faction:
    """Which faction this entity belongs to."""

    __slots__ = ("name",)

    def __init__(self, name: str) -> None:
        self.name = name


class Health:
    """Destructible entity."""

    __slots__ = ("hp", "max_hp")

    def __init__(self, hp: int, max_hp: int) -> None:
        self.hp = hp
        self.max_hp = max_hp


class Collidable:
    """Convex polygon collision boundary in local space."""

    __slots__ = ("vertices", "bounding_radius")

    def __init__(self, vertices: tuple[tuple[float, float], ...]) -> None:
        self.vertices = vertices
        self.bounding_radius = max(
            (x * x + y * y) ** 0.5 for x, y in vertices
        )


class BotControl:
    """AI-controlled entity. Removed when a human takes over."""

    __slots__ = ("behavior", "throttle", "rudder", "waypoint_index", "target_entity")

    def __init__(
        self,
        behavior: str,
        throttle: float = 0.0,
        rudder: float = 0.0,
        waypoint_index: int = 0,
        target_entity: int = 0,
    ) -> None:
        self.behavior = behavior
        self.throttle = throttle
        self.rudder = rudder
        self.waypoint_index = waypoint_index
        self.target_entity = target_entity


class PlayerControl:
    """Human-controlled entity."""

    __slots__ = ("connection_id", "throttle", "rudder")

    def __init__(
        self,
        connection_id: int,
        throttle: float = 0.0,
        rudder: float = 0.0,
    ) -> None:
        self.connection_id = connection_id
        self.throttle = throttle
        self.rudder = rudder


class RespawnTimer:
    """Countdown to respawn after death or delivery."""

    __slots__ = ("remaining",)

    def __init__(self, remaining: float = 3.0) -> None:
        self.remaining = remaining
