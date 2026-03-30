"""SAT-based convex polygon collision with impulse-based resolution.

Each vehicle type has a collision polygon that matches its hull shape.
SAT (Separating Axis Theorem) detects overlap and returns the collision
normal, penetration depth, and contact point. These feed into the same
impulse resolver used previously (restitution, friction, angular velocity).
"""

import math

import esper

from hormuz.components import Collidable, Health, Transform, VehiclePhysics

# Collision polygons per vehicle type — local-space [forward, starboard],
# fractions of vehicle size. CCW winding order.
COLLISION_POLYGONS: dict[str, tuple[tuple[float, float], ...]] = {
    "speedboat": (
        (0.5, 0),
        (0.2, 0.08),
        (-0.2, 0.14),
        (-0.42, 0.06),
        (-0.42, -0.06),
        (-0.2, -0.14),
        (0.2, -0.08),
    ),
    "frigate": (
        (0.5, 0),
        (0.3, 0.045),
        (-0.1, 0.08),
        (-0.4, 0.065),
        (-0.45, 0),
        (-0.4, -0.065),
        (-0.1, -0.08),
        (0.3, -0.045),
    ),
    "oil_tanker": (
        (0.5, 0),
        (0.38, 0.085),
        (0.1, 0.09),
        (-0.3, 0.09),
        (-0.46, 0),
        (-0.3, -0.09),
        (0.1, -0.09),
        (0.38, -0.085),
    ),
    "truck": (
        (0.44, 0.18),
        (-0.48, 0.18),
        (-0.48, -0.18),
        (0.44, -0.18),
    ),
    "quadcopter": (
        (0.38, 0.38),
        (-0.38, 0.38),
        (-0.38, -0.38),
        (0.38, -0.38),
    ),
    "shahed": (
        (0.5, 0),
        (0.15, 0.1),
        (-0.2, 0.35),
        (-0.4, 0),
        (-0.2, -0.35),
        (0.15, -0.1),
    ),
}

RESTITUTION = 0.3
FRICTION = 0.4


COLLISION_ITERATIONS = 3


class CollisionProcessor(esper.Processor):
    def process(self, dt: float = 0.05) -> None:
        entities = [
            (ent, tf, phys, col)
            for ent, (tf, phys, col, health) in esper.get_components(
                Transform, VehiclePhysics, Collidable, Health
            )
            if health.hp > 0
        ]

        for _ in range(COLLISION_ITERATIONS):
            for i in range(len(entities)):
                _, tf_a, phys_a, col_a = entities[i]
                for j in range(i + 1, len(entities)):
                    _, tf_b, phys_b, col_b = entities[j]
                    _resolve_collision(tf_a, phys_a, col_a, tf_b, phys_b, col_b)


def _transform_polygon(
    vertices: tuple[tuple[float, float], ...],
    x: float,
    y: float,
    heading: float,
    size: float,
) -> list[tuple[float, float]]:
    cos_h = math.cos(heading)
    sin_h = math.sin(heading)
    return [
        (x + (lx * cos_h - ly * sin_h) * size, y + (lx * sin_h + ly * cos_h) * size)
        for lx, ly in vertices
    ]


def _project_polygon(
    poly: list[tuple[float, float]], ax: float, ay: float
) -> tuple[float, float]:
    mn = mx = poly[0][0] * ax + poly[0][1] * ay
    for i in range(1, len(poly)):
        d = poly[i][0] * ax + poly[i][1] * ay
        if d < mn:
            mn = d
        if d > mx:
            mx = d
    return mn, mx


def _sat_collision(
    poly_a: list[tuple[float, float]],
    poly_b: list[tuple[float, float]],
    cx_a: float,
    cy_a: float,
    cx_b: float,
    cy_b: float,
) -> tuple[float, float, float, float, float] | None:
    """SAT test. Returns (nx, ny, depth, contact_x, contact_y) or None."""
    min_depth = float("inf")
    min_nx = 0.0
    min_ny = 0.0

    for poly in (poly_a, poly_b):
        n = len(poly)
        for i in range(n):
            j = (i + 1) % n
            ex = poly[j][0] - poly[i][0]
            ey = poly[j][1] - poly[i][1]
            nx = -ey
            ny = ex
            length = math.sqrt(nx * nx + ny * ny)
            if length < 1e-10:
                continue
            nx /= length
            ny /= length

            min_a, max_a = _project_polygon(poly_a, nx, ny)
            min_b, max_b = _project_polygon(poly_b, nx, ny)

            overlap = min(max_a - min_b, max_b - min_a)
            if overlap <= 0:
                return None

            if overlap < min_depth:
                min_depth = overlap
                min_nx = nx
                min_ny = ny

    # Ensure normal points from A toward B
    dx = cx_b - cx_a
    dy = cy_b - cy_a
    if min_nx * dx + min_ny * dy < 0:
        min_nx = -min_nx
        min_ny = -min_ny

    # Contact point: deepest penetrating vertices from each polygon
    best_a = -float("inf")
    ca_x = ca_y = 0.0
    for vx, vy in poly_b:
        d = -(vx * min_nx + vy * min_ny)
        if d > best_a:
            best_a = d
            ca_x, ca_y = vx, vy

    best_b = -float("inf")
    cb_x = cb_y = 0.0
    for vx, vy in poly_a:
        d = vx * min_nx + vy * min_ny
        if d > best_b:
            best_b = d
            cb_x, cb_y = vx, vy

    contact_x = (ca_x + cb_x) * 0.5
    contact_y = (ca_y + cb_y) * 0.5

    return min_nx, min_ny, min_depth, contact_x, contact_y


def _resolve_collision(
    tf_a: Transform,
    phys_a: VehiclePhysics,
    col_a: Collidable,
    tf_b: Transform,
    phys_b: VehiclePhysics,
    col_b: Collidable,
) -> None:
    # Broad phase: bounding circle
    br_a = col_a.bounding_radius * phys_a.size
    br_b = col_b.bounding_radius * phys_b.size
    dx = tf_b.x - tf_a.x
    dy = tf_b.y - tf_a.y
    dist_sq = dx * dx + dy * dy
    br_sum = br_a + br_b
    if dist_sq > br_sum * br_sum:
        return

    # Transform polygons to world space
    poly_a = _transform_polygon(col_a.vertices, tf_a.x, tf_a.y, tf_a.heading, phys_a.size)
    poly_b = _transform_polygon(col_b.vertices, tf_b.x, tf_b.y, tf_b.heading, phys_b.size)

    # Narrow phase: SAT
    result = _sat_collision(poly_a, poly_b, tf_a.x, tf_a.y, tf_b.x, tf_b.y)
    if result is None:
        return

    nx, ny, overlap, cx, cy = result

    # --- Mass and inertia ---
    mass_a = phys_a.size * phys_a.size
    mass_b = phys_b.size * phys_b.size
    total_mass = mass_a + mass_b
    inv_mass_a = 1.0 / mass_a
    inv_mass_b = 1.0 / mass_b

    i_a = mass_a * br_a * br_a
    i_b = mass_b * br_b * br_b
    inv_i_a = 1.0 / i_a
    inv_i_b = 1.0 / i_b

    # --- Position correction ---
    tf_a.x -= nx * overlap * (mass_b / total_mass)
    tf_a.y -= ny * overlap * (mass_b / total_mass)
    tf_b.x += nx * overlap * (mass_a / total_mass)
    tf_b.y += ny * overlap * (mass_a / total_mass)

    # --- Contact point offset from centers ---
    r_ax = cx - tf_a.x
    r_ay = cy - tf_a.y
    r_bx = cx - tf_b.x
    r_by = cy - tf_b.y

    # --- Convert speed/drift to world velocity ---
    cos_a = math.cos(tf_a.heading)
    sin_a = math.sin(tf_a.heading)
    cos_b = math.cos(tf_b.heading)
    sin_b = math.sin(tf_b.heading)

    vax = cos_a * tf_a.speed - sin_a * tf_a.drift
    vay = sin_a * tf_a.speed + cos_a * tf_a.drift
    vbx = cos_b * tf_b.speed - sin_b * tf_b.drift
    vby = sin_b * tf_b.speed + cos_b * tf_b.drift

    omega_a = tf_a.angular_velocity
    omega_b = tf_b.angular_velocity

    # Velocity at contact
    vcax = vax - omega_a * r_ay
    vcay = vay + omega_a * r_ax
    vcbx = vbx - omega_b * r_by
    vcby = vby + omega_b * r_bx

    vrel_x = vcax - vcbx
    vrel_y = vcay - vcby
    vrel_n = vrel_x * nx + vrel_y * ny

    if vrel_n < 0:
        return

    # --- Normal impulse ---
    raxn = r_ax * ny - r_ay * nx
    rbxn = r_bx * ny - r_by * nx

    denom = inv_mass_a + inv_mass_b + raxn * raxn * inv_i_a + rbxn * rbxn * inv_i_b
    j_normal = -(1.0 + RESTITUTION) * vrel_n / denom

    jnx = j_normal * nx
    jny = j_normal * ny

    vax += jnx * inv_mass_a
    vay += jny * inv_mass_a
    vbx -= jnx * inv_mass_b
    vby -= jny * inv_mass_b

    omega_a += (r_ax * jny - r_ay * jnx) * inv_i_a
    omega_b -= (r_bx * jny - r_by * jnx) * inv_i_b

    # --- Friction impulse ---
    tx = -ny
    ty = nx
    vrel_t = vrel_x * tx + vrel_y * ty

    raxt = r_ax * ty - r_ay * tx
    rbxt = r_bx * ty - r_by * tx
    denom_t = inv_mass_a + inv_mass_b + raxt * raxt * inv_i_a + rbxt * rbxt * inv_i_b

    j_tangent = -vrel_t / denom_t
    max_friction = abs(j_normal) * FRICTION
    if abs(j_tangent) > max_friction:
        j_tangent = math.copysign(max_friction, j_tangent)

    jtx = j_tangent * tx
    jty = j_tangent * ty

    vax += jtx * inv_mass_a
    vay += jty * inv_mass_a
    vbx -= jtx * inv_mass_b
    vby -= jty * inv_mass_b

    omega_a += (r_ax * jty - r_ay * jtx) * inv_i_a
    omega_b -= (r_bx * jty - r_by * jtx) * inv_i_b

    # --- Convert back ---
    tf_a.speed = vax * cos_a + vay * sin_a
    tf_a.drift = -vax * sin_a + vay * cos_a
    tf_a.angular_velocity = omega_a

    tf_b.speed = vbx * cos_b + vby * sin_b
    tf_b.drift = -vbx * sin_b + vby * cos_b
    tf_b.angular_velocity = omega_b
