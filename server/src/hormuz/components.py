"""ECS components for the Hormuz game server."""

from dataclasses import dataclass, field


@dataclass(slots=True)
class Transform:
    """Position and orientation in world space."""

    x: float
    y: float
    heading: float = 0.0
    speed: float = 0.0
    drift: float = 0.0
    angular_velocity: float = 0.0
    flood_level: float = 0.0
    list_angle: float = 0.0
    hull_breaches: int = 0
    breach_side: float = 0.0


@dataclass(slots=True)
class VehiclePhysics:
    """Physics parameters — immutable per vehicle type."""

    vehicle_type: str
    max_speed: float = 0.0
    acceleration: float = 0.0
    drag: float = 0.95
    turn_rate: float = 0.0
    drift_factor: float = 0.0
    lateral_drag: float = 0.1
    min_turn_fraction: float = 0.0
    cruise_speed: float = 0.0
    airborne: bool = False
    size: float = 10.0
    angular_drag: float = 0.15
    # Force-based propulsion (Phase 1)
    mass: float = 100.0
    engine_power: float = 0.0
    drag_coefficient: float = 1.0
    # Propeller torque steering (Phase 2)
    propeller_offset: float = 0.0
    rudder_max_angle: float = 0.0
    moment_of_inertia: float = 0.0
    rudder_flow_coefficient: float = 0.0


@dataclass(slots=True)
class Faction:
    """Which faction this entity belongs to."""

    name: str


@dataclass(slots=True)
class Health:
    """Destructible entity."""

    hp: int
    max_hp: int


@dataclass(slots=True)
class Collidable:
    """Convex polygon collision boundary in local space."""

    vertices: tuple[tuple[float, float], ...]
    bounding_radius: float = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "bounding_radius",
            max((x * x + y * y) ** 0.5 for x, y in self.vertices),
        )


@dataclass(slots=True)
class BotControl:
    """AI-controlled entity. Removed when a human takes over."""

    behavior: str
    throttle: float = 0.0
    rudder: float = 0.0
    waypoint_index: int = 0
    target_entity: int = 0


@dataclass(slots=True)
class PlayerControl:
    """Human-controlled entity."""

    connection_id: int
    throttle: float = 0.0
    rudder: float = 0.0
    autopilot: bool = False
    waypoint_index: int = 0


@dataclass(slots=True)
class CargoState:
    """Tanker cargo state — affects physics (mass, drag) and route."""

    loaded: bool = True
    # "oman" = heading to Gulf of Oman, "gulf" = heading back to Persian Gulf
    destination: str = "oman"


@dataclass(slots=True)
class PatrolZone:
    """Assigned patrol area for frigates (future AI behavior)."""

    center_x: float
    center_y: float
    radius: float
    zone_id: str


@dataclass(slots=True)
class SpawnConfig:
    """Identity of an entity's role in the world — survives player takeover and respawn."""

    behavior: str


@dataclass(slots=True)
class RespawnTimer:
    """Countdown to respawn after death or delivery."""

    remaining: float = 3.0


@dataclass(slots=True)
class Battery:
    """Finite energy supply for airborne drones."""

    charge: float = 100.0
    # drain_rate is percent per second (default: 100% over 600s = 10 minutes)
    drain_rate: float = 100.0 / 600.0
