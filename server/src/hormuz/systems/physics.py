"""Physics processor — port of client/src/vehicles/physics.ts updateVehicle()."""

import math

import esper

from hormuz.components import (
    Battery,
    BotControl,
    CargoState,
    Health,
    PlayerControl,
    Transform,
    VehiclePhysics,
)
from hormuz.entity_helpers import kill_entity
from hormuz.generated.vehicles import BREACHES_TO_SINK
from hormuz.systems.bot_ai import run_tanker_ai

# Re-export for combat.py import
__all__ = ["PhysicsProcessor", "BREACH_CLAMP_COUNT", "BREACH_RATE"]

TWO_PI = math.pi * 2

# Flooding constants (match client FLOOD object)
BREACH_RATE = 0.03
MAX_LIST = 1.2
LERP_RATE = 3.0
BREACH_CLAMP_COUNT = 1
FLOOD_DRAG_FACTOR = 1.5

# Empty (ballast) tanker physics modifiers
EMPTY_MASS_FACTOR = 0.4  # 40% of loaded mass
EMPTY_DRAG_FACTOR = 0.6  # 60% of loaded drag (sits higher, less wetted surface)


class PhysicsProcessor(esper.Processor):
    def __init__(self) -> None:
        super().__init__()
        self.flood_kills: list[str] = []  # vehicle types killed by flooding
        self.battery_kills: list[str] = []  # vehicle types killed by battery depletion

    def process(self, dt: float = 0.05) -> None:
        self.flood_kills.clear()
        self.battery_kills.clear()
        for ent, (tf, phys) in esper.get_components(Transform, VehiclePhysics):
            throttle, rudder = self._get_input(ent)

            # Apply cargo modifiers for empty tankers
            cargo = esper.try_component(ent, CargoState)
            mass_factor = 1.0
            drag_factor = 1.0
            if cargo is not None and not cargo.loaded:
                mass_factor = EMPTY_MASS_FACTOR
                drag_factor = EMPTY_DRAG_FACTOR

            _update_vehicle(tf, phys, throttle, rudder, dt, mass_factor, drag_factor)
            _update_flooding(tf, phys, dt)

            # Flooding kills the entity
            if tf.flood_level >= 1.0:
                health = esper.try_component(ent, Health)
                if health is not None and health.hp > 0:
                    kill_entity(ent)
                    self.flood_kills.append(phys.vehicle_type)

            # Battery depletion kills airborne drones
            battery = esper.try_component(ent, Battery)
            if battery is not None:
                health = esper.try_component(ent, Health)
                if health is not None and health.hp > 0:
                    battery.charge = max(0.0, battery.charge - battery.drain_rate * dt)
                    if battery.charge <= 0.0:
                        kill_entity(ent)
                        self.battery_kills.append(phys.vehicle_type)

    def _get_input(self, ent: int) -> tuple[float, float]:
        pc = esper.try_component(ent, PlayerControl)
        if pc is not None:
            if pc.autopilot:
                # Autopilot controls steering only — player keeps throttle control
                tf = esper.component_for_entity(ent, Transform)
                cargo = esper.try_component(ent, CargoState)
                destination = cargo.destination if cargo else "oman"
                _, rudder, pc.waypoint_index = run_tanker_ai(
                    tf, pc.waypoint_index, destination
                )
                return pc.throttle, rudder
            return pc.throttle, pc.rudder
        bc = esper.try_component(ent, BotControl)
        if bc is not None:
            return bc.throttle, bc.rudder
        return 0.0, 0.0


def _equilibrium_speed(phys: VehiclePhysics) -> float:
    if phys.drag_coefficient <= 0 or phys.engine_power <= 0:
        return phys.max_speed  # fallback for unconfigured vehicles
    return math.sqrt(phys.engine_power / phys.drag_coefficient)


def _update_vehicle(
    tf: Transform,
    phys: VehiclePhysics,
    throttle: float,
    rudder: float,
    dt: float,
    mass_factor: float = 1.0,
    drag_factor: float = 1.0,
) -> None:
    # Effective mass and drag (modified by cargo state)
    eff_mass = phys.mass * mass_factor
    eff_drag_coeff = phys.drag_coefficient * drag_factor

    # --- Angular velocity (from collisions + propeller torque) ---
    tf.heading += tf.angular_velocity * dt
    tf.angular_velocity *= phys.angular_drag**dt
    if abs(tf.angular_velocity) < 0.001:
        tf.angular_velocity = 0.0

    # --- Compute thrust ---
    thrust = 0.0
    if throttle > 0:
        thrust = throttle * phys.engine_power
    elif throttle < 0:
        thrust = throttle * phys.engine_power * 0.3  # reverse is much weaker

    # --- Steering ---
    eq_speed = _equilibrium_speed(phys)

    if phys.propeller_offset != 0.0:
        # Propeller torque steering (ships)
        rudder_angle = rudder * phys.rudder_max_angle
        sin_rudder = math.sin(rudder_angle)
        prop_wash_force = -thrust * sin_rudder
        flow_force = (
            -phys.rudder_flow_coefficient
            * tf.speed
            * abs(tf.speed)
            * sin_rudder
        )
        lateral_force = prop_wash_force + flow_force
        torque = phys.propeller_offset * phys.size * lateral_force
        tf.angular_velocity += (torque / phys.moment_of_inertia) * dt
        tf.drift += (lateral_force / eff_mass) * dt
        thrust *= math.cos(rudder_angle)
    else:
        # Direct steering (drones)
        speed_ratio = min(abs(tf.speed) / eq_speed, 1.0) if eq_speed > 0 else 0.0
        if phys.min_turn_fraction > 0:
            rudder_effect = max(phys.min_turn_fraction, speed_ratio)
        else:
            rudder_effect = 0.0 if speed_ratio < 0.05 else speed_ratio
        steer_sign = -1.0 if tf.speed < 0 else 1.0
        tf.heading += rudder * phys.turn_rate * rudder_effect * steer_sign * dt
        tf.drift += (
            rudder * phys.turn_rate * rudder_effect * tf.speed * phys.drift_factor * dt
        )

    # Normalize heading to [0, 2pi)
    tf.heading = tf.heading % TWO_PI
    if tf.heading < 0:
        tf.heading += TWO_PI

    # --- Forward thrust and drag ---
    drag = eff_drag_coeff * tf.speed * abs(tf.speed)
    tf.speed += ((thrust - drag) / eff_mass) * dt

    # Lateral drag
    tf.drift *= phys.lateral_drag**dt

    # --- Slope forces skipped (open water + airborne drones) ---

    # --- Cruise speed (fixed-wing drones) ---
    if phys.cruise_speed > 0:
        tf.speed = phys.cruise_speed

    # --- Clamp ---
    tf.speed = max(-eq_speed * 0.2, min(eq_speed * 1.05, tf.speed))
    if abs(tf.speed) < 0.05 and throttle == 0:
        tf.speed = 0.0
    if abs(tf.drift) < 0.02:
        tf.drift = 0.0

    # --- Move ---
    cos_h = math.cos(tf.heading)
    sin_h = math.sin(tf.heading)
    tf.x += (cos_h * tf.speed - sin_h * tf.drift) * dt
    tf.y += (sin_h * tf.speed + cos_h * tf.drift) * dt


def _update_flooding(tf: Transform, phys: VehiclePhysics, dt: float) -> None:
    if tf.hull_breaches == 0 or phys.airborne or phys.vehicle_type == "truck":
        return

    # Flood level caps based on number of breaches — need BREACHES_TO_SINK breaches to fully sink
    max_flood = min(tf.hull_breaches / BREACHES_TO_SINK, 1.0)

    # Water ingress accelerates as ship takes on more water
    ingress = tf.hull_breaches * BREACH_RATE * (1.0 + tf.flood_level)
    tf.flood_level = min(tf.flood_level + ingress * dt, max_flood)

    # List toward damaged side
    target_list = tf.breach_side * MAX_LIST * tf.flood_level
    tf.list_angle += (target_list - tf.list_angle) * (1.0 - math.exp(-LERP_RATE * dt))

    # Flooding increases drag
    flood_drag = (
        tf.flood_level
        * FLOOD_DRAG_FACTOR
        * phys.drag_coefficient
        * tf.speed
        * abs(tf.speed)
    )
    tf.speed -= (flood_drag / phys.mass) * dt
