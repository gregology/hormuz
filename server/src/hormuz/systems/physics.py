"""Physics processor — port of client/src/vehicles/physics.ts updateVehicle()."""

import math

import esper

from hormuz.components import BotControl, PlayerControl, Transform, VehiclePhysics

TWO_PI = math.pi * 2


class PhysicsProcessor(esper.Processor):
    def process(self, dt: float = 0.05) -> None:
        for ent, (tf, phys) in esper.get_components(Transform, VehiclePhysics):
            throttle, rudder = self._get_input(ent)
            _update_vehicle(tf, phys, throttle, rudder, dt)

    def _get_input(self, ent: int) -> tuple[float, float]:
        pc = esper.try_component(ent, PlayerControl)
        if pc is not None:
            return pc.throttle, pc.rudder
        bc = esper.try_component(ent, BotControl)
        if bc is not None:
            return bc.throttle, bc.rudder
        return 0.0, 0.0


def _update_vehicle(
    tf: Transform,
    phys: VehiclePhysics,
    throttle: float,
    rudder: float,
    dt: float,
) -> None:
    # --- Angular velocity from collisions ---
    tf.heading += tf.angular_velocity * dt
    tf.angular_velocity *= phys.angular_drag**dt
    if abs(tf.angular_velocity) < 0.001:
        tf.angular_velocity = 0.0

    # --- Steering ---
    speed_ratio = min(abs(tf.speed) / phys.max_speed, 1.0) if phys.max_speed > 0 else 0.0

    if phys.min_turn_fraction > 0:
        rudder_effect = max(phys.min_turn_fraction, speed_ratio)
    else:
        rudder_effect = 0.0 if speed_ratio < 0.05 else speed_ratio

    steer_sign = -1.0 if tf.speed < 0 else 1.0
    turn_amount = rudder * phys.turn_rate * rudder_effect * steer_sign * dt
    tf.heading += turn_amount

    # Normalize heading to [0, 2pi)
    tf.heading = tf.heading % TWO_PI
    if tf.heading < 0:
        tf.heading += TWO_PI

    # --- Drift from turning ---
    tf.drift += rudder * phys.turn_rate * rudder_effect * tf.speed * phys.drift_factor * dt

    # --- Throttle ---
    if throttle > 0:
        tf.speed += throttle * phys.acceleration * dt
    elif throttle < 0:
        tf.speed += throttle * phys.acceleration * 0.3 * dt

    # --- Drag ---
    tf.speed *= phys.drag**dt
    tf.drift *= phys.lateral_drag**dt

    # --- Slope forces skipped for MVP (airborne drones + open water tankers) ---

    # --- Cruise speed (fixed-wing drones) ---
    if phys.cruise_speed > 0:
        tf.speed = phys.cruise_speed

    # --- Clamp ---
    tf.speed = max(-phys.max_speed * 0.2, min(phys.max_speed, tf.speed))
    if abs(tf.speed) < 0.05 and throttle == 0:
        tf.speed = 0.0
    if abs(tf.drift) < 0.02:
        tf.drift = 0.0

    # --- Move ---
    cos_h = math.cos(tf.heading)
    sin_h = math.sin(tf.heading)
    tf.x += (cos_h * tf.speed - sin_h * tf.drift) * dt
    tf.y += (sin_h * tf.speed + cos_h * tf.drift) * dt
