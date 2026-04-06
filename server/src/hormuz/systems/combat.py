"""Combat processor — shahed kamikaze, frigate autocannon, speedboat guns.

Shaheds attack tankers and frigates via polygon collision (SAT).
Frigates engage hostile targets with an autocannon: lead-predicted projectiles
tracked as lightweight data (not ECS entities).
Speedboats engage tankers/frigates with a bow gun and RPG at close range.
"""

import math
import random

import esper

from hormuz.components import (
    BotControl,
    Collidable,
    Health,
    PlayerControl,
    RespawnTimer,
    Transform,
    VehiclePhysics,
)
from hormuz.generated.vehicles import (
    AUTOCANNON_COOLDOWN,
    AUTOCANNON_DAMAGE,
    AUTOCANNON_HIT_RADIUS,
    AUTOCANNON_PROJECTILE_LIFETIME,
    AUTOCANNON_PROJECTILE_SPEED,
    AUTOCANNON_RANGE,
    AUTOCANNON_SPREAD,
    BREACHES_TO_SINK,
    DETECTION_RANGE,
    JAM_RADIUS,
    QUADCOPTER_FRIGATE_BREACHES,
    QUADCOPTER_HP_DAMAGE,
    QUADCOPTER_TANKER_BREACHES,
    VEHICLES,
)
from hormuz.systems.collision import _sat_collision, _transform_polygon
from hormuz.systems.danger_scent import emit_danger_scent

# Derived squared constants for distance checks
JAM_RADIUS_SQ = JAM_RADIUS * JAM_RADIUS
AUTOCANNON_RANGE_SQ = AUTOCANNON_RANGE * AUTOCANNON_RANGE
# Frigate detection range² per target type (from radar model)
_FRIGATE_DET = DETECTION_RANGE.get("frigate", {})
RADAR_RANGE_SQ: dict[str, float] = {k: v * v for k, v in _FRIGATE_DET.items()}
AUTOCANNON_HIT_RADIUS_SQ: dict[str, float] = {k: v * v for k, v in AUTOCANNON_HIT_RADIUS.items()}

# --- Speedboat weapon constants (extracted from YAML definitions) ---
_SB_BOW_GUN = VEHICLES["speedboat"].components["bow_gun"]
BOW_GUN_DAMAGE: int = _SB_BOW_GUN["damage"]
BOW_GUN_RANGE: float = float(_SB_BOW_GUN["range"])
BOW_GUN_RANGE_SQ: float = BOW_GUN_RANGE * BOW_GUN_RANGE
BOW_GUN_COOLDOWN: float = float(_SB_BOW_GUN["cooldown"])
BOW_GUN_ARC_COS: float = 0.707  # forward arc: ±45° from heading

_SB_RPG = VEHICLES["speedboat"].components["rpg"]
RPG_DAMAGE: int = _SB_RPG["damage"]
RPG_RANGE: float = float(_SB_RPG["range"])
RPG_RANGE_SQ: float = RPG_RANGE * RPG_RANGE
RPG_COOLDOWN: float = float(_SB_RPG["cooldown"])
RPG_TANKER_BREACHES: int = 1


class _Projectile:
    __slots__ = ("x", "y", "vx", "vy", "remaining")

    def __init__(self, x: float, y: float, vx: float, vy: float, lifetime: float) -> None:
        self.x = x
        self.y = y
        self.vx = vx
        self.vy = vy
        self.remaining = lifetime


class _AutocannonState:
    __slots__ = ("target", "cooldown")

    def __init__(self) -> None:
        self.target: int | None = None
        self.cooldown: float = 0.0


class _SpeedboatWeaponState:
    __slots__ = ("bow_gun_cooldown", "rpg_cooldown")

    def __init__(self) -> None:
        self.bow_gun_cooldown: float = 0.0
        self.rpg_cooldown: float = 0.0


class CombatProcessor(esper.Processor):
    def __init__(self) -> None:
        super().__init__()
        self.events: list[dict] = []
        self.kills: list[dict] = []  # {"victim_type": str, "cause": str}
        self._projectiles: list[_Projectile] = []
        self._autocannon: dict[int, _AutocannonState] = {}
        self._speedboat_weapons: dict[int, _SpeedboatWeaponState] = {}

    def process(self, dt: float = 0.05) -> None:
        self.events.clear()
        self.kills.clear()

        # Gather live entities by type
        shaheds: list[tuple[int, Transform, VehiclePhysics, Collidable]] = []
        quadcopters: list[tuple[int, Transform, VehiclePhysics, Collidable]] = []
        tankers: list[tuple[int, Transform, VehiclePhysics, Collidable]] = []
        frigates: list[tuple[int, Transform, VehiclePhysics, Collidable]] = []
        speedboats: list[tuple[int, Transform, VehiclePhysics, Collidable]] = []

        for ent, (tf, phys, col, health) in esper.get_components(
            Transform, VehiclePhysics, Collidable, Health
        ):
            if health.hp <= 0:
                continue
            if phys.vehicle_type == "shahed":
                shaheds.append((ent, tf, phys, col))
            elif phys.vehicle_type == "quadcopter":
                quadcopters.append((ent, tf, phys, col))
            elif phys.vehicle_type == "oil_tanker":
                tankers.append((ent, tf, phys, col))
            elif phys.vehicle_type == "frigate":
                frigates.append((ent, tf, phys, col))
            elif phys.vehicle_type == "speedboat":
                speedboats.append((ent, tf, phys, col))

        # Combine all hostile targets for autocannon (drones + speedboats)
        all_targets = shaheds + quadcopters + speedboats

        # 1. Autocannon — target, fire, advance projectiles, check hits
        self._update_autocannons(frigates, all_targets, dt)
        killed_by_autocannon = self._advance_projectiles(all_targets, dt)

        # Filter killed entities before kamikaze/attack phase
        if killed_by_autocannon:
            shaheds = [s for s in shaheds if s[0] not in killed_by_autocannon]
            quadcopters = [q for q in quadcopters if q[0] not in killed_by_autocannon]
            speedboats = [s for s in speedboats if s[0] not in killed_by_autocannon]

        # 2. Shahed kamikaze — vs tankers and frigates
        self._shahed_kamikaze(shaheds, tankers, frigates)

        # 3. Quadcopter kamikaze — vs tankers and frigates
        self._quadcopter_kamikaze(quadcopters, tankers, frigates)

        # 4. Speedboat weapons — bow gun + RPG vs tankers and frigates
        self._speedboat_attacks(speedboats, tankers, frigates, dt)

    # ------------------------------------------------------------------
    # Autocannon
    # ------------------------------------------------------------------

    def _update_autocannons(
        self,
        frigates: list[tuple[int, Transform, VehiclePhysics, Collidable]],
        shaheds: list[tuple[int, Transform, VehiclePhysics, Collidable]],
        dt: float,
    ) -> None:
        # Prune state for dead/removed frigates
        active_ids = {ent for ent, _, _, _ in frigates}
        for eid in [k for k in self._autocannon if k not in active_ids]:
            del self._autocannon[eid]

        for f_ent, f_tf, _, _ in frigates:
            state = self._autocannon.get(f_ent)
            if state is None:
                state = _AutocannonState()
                self._autocannon[f_ent] = state

            state.cooldown -= dt

            # Validate current target (alive, on radar, and in autocannon range?)
            if state.target is not None:
                valid = False
                for s_ent, s_tf, s_phys, _ in shaheds:
                    if s_ent == state.target:
                        dx = s_tf.x - f_tf.x
                        dy = s_tf.y - f_tf.y
                        d_sq = dx * dx + dy * dy
                        radar_sq = RADAR_RANGE_SQ.get(s_phys.vehicle_type, 0.0)
                        if d_sq <= AUTOCANNON_RANGE_SQ and d_sq <= radar_sq:
                            valid = True
                        break
                if not valid:
                    state.target = None

            # Acquire new target — nearest drone on radar and in autocannon range
            if state.target is None:
                best_dist_sq = AUTOCANNON_RANGE_SQ
                best_ent: int | None = None
                for s_ent, s_tf, s_phys, _ in shaheds:
                    dx = s_tf.x - f_tf.x
                    dy = s_tf.y - f_tf.y
                    d_sq = dx * dx + dy * dy
                    radar_sq = RADAR_RANGE_SQ.get(s_phys.vehicle_type, 0.0)
                    if d_sq <= best_dist_sq and d_sq <= radar_sq:
                        best_dist_sq = d_sq
                        best_ent = s_ent
                state.target = best_ent

            # Fire
            if state.target is not None and state.cooldown <= 0:
                self._fire_autocannon(f_tf, state, shaheds)
                state.cooldown = AUTOCANNON_COOLDOWN

    def _fire_autocannon(
        self,
        f_tf: Transform,
        state: _AutocannonState,
        shaheds: list[tuple[int, Transform, VehiclePhysics, Collidable]],
    ) -> None:
        target_tf: Transform | None = None
        for s_ent, s_tf, _, _ in shaheds:
            if s_ent == state.target:
                target_tf = s_tf
                break
        if target_tf is None:
            return

        dx = target_tf.x - f_tf.x
        dy = target_tf.y - f_tf.y
        dist = math.sqrt(dx * dx + dy * dy)
        if dist < 1.0:
            return

        # Lead targeting — predict where target will be when projectile arrives
        t_intercept = dist / AUTOCANNON_PROJECTILE_SPEED
        t_vx = math.cos(target_tf.heading) * target_tf.speed
        t_vy = math.sin(target_tf.heading) * target_tf.speed
        pred_x = target_tf.x + t_vx * t_intercept
        pred_y = target_tf.y + t_vy * t_intercept

        aim_dx = pred_x - f_tf.x
        aim_dy = pred_y - f_tf.y
        aim_dist = math.sqrt(aim_dx * aim_dx + aim_dy * aim_dy)
        if aim_dist < 1.0:
            return

        # Aim angle with random spread
        aim_angle = math.atan2(aim_dy, aim_dx)
        aim_angle += random.uniform(-AUTOCANNON_SPREAD, AUTOCANNON_SPREAD)

        vx = math.cos(aim_angle) * AUTOCANNON_PROJECTILE_SPEED
        vy = math.sin(aim_angle) * AUTOCANNON_PROJECTILE_SPEED

        self._projectiles.append(
            _Projectile(f_tf.x, f_tf.y, vx, vy, AUTOCANNON_PROJECTILE_LIFETIME)
        )

        self.events.append(
            {
                "type": "projectile",
                "x": f_tf.x,
                "y": f_tf.y,
                "target_x": pred_x,
                "target_y": pred_y,
            }
        )

    def _advance_projectiles(
        self,
        shaheds: list[tuple[int, Transform, VehiclePhysics, Collidable]],
        dt: float,
    ) -> set[int]:
        """Advance projectiles, check hits. Returns set of killed shahed entity IDs."""
        surviving: list[_Projectile] = []
        killed: set[int] = set()

        for proj in self._projectiles:
            proj.x += proj.vx * dt
            proj.y += proj.vy * dt
            proj.remaining -= dt

            if proj.remaining <= 0:
                continue

            hit = False
            for s_ent, s_tf, s_phys, _ in shaheds:
                if s_ent in killed:
                    continue
                pdx = proj.x - s_tf.x
                pdy = proj.y - s_tf.y
                hit_r_sq = AUTOCANNON_HIT_RADIUS_SQ.get(
                    s_phys.vehicle_type, AUTOCANNON_HIT_RADIUS_SQ["shahed"]
                )
                if pdx * pdx + pdy * pdy <= hit_r_sq:
                    health = esper.component_for_entity(s_ent, Health)
                    health.hp = max(0, health.hp - AUTOCANNON_DAMAGE)
                    if health.hp <= 0:
                        self._kill(s_ent)
                        killed.add(s_ent)
                        self.kills.append(
                            {
                                "victim_type": s_phys.vehicle_type,
                                "cause": "autocannon",
                            }
                        )
                    self.events.append({"type": "explosion", "x": s_tf.x, "y": s_tf.y})
                    hit = True
                    break

            if not hit:
                surviving.append(proj)

        self._projectiles = surviving
        return killed

    # ------------------------------------------------------------------
    # Shahed kamikaze
    # ------------------------------------------------------------------

    def _shahed_kamikaze(
        self,
        shaheds: list[tuple[int, Transform, VehiclePhysics, Collidable]],
        tankers: list[tuple[int, Transform, VehiclePhysics, Collidable]],
        frigates: list[tuple[int, Transform, VehiclePhysics, Collidable]],
    ) -> None:
        targets = [(ent, tf, phys, col, BREACHES_TO_SINK) for ent, tf, phys, col in tankers] + [
            (ent, tf, phys, col, 2) for ent, tf, phys, col in frigates
        ]

        hit_shaheds: set[int] = set()

        for s_ent, s_tf, s_phys, s_col in shaheds:
            if s_ent in hit_shaheds:
                continue
            for t_ent, t_tf, t_phys, t_col, breach_count in targets:
                dx = t_tf.x - s_tf.x
                dy = t_tf.y - s_tf.y
                dist_sq = dx * dx + dy * dy
                br_sum = s_col.bounding_radius * s_phys.size + t_col.bounding_radius * t_phys.size
                if dist_sq > br_sum * br_sum:
                    continue

                s_poly = _transform_polygon(
                    s_col.vertices, s_tf.x, s_tf.y, s_tf.heading, s_phys.size
                )
                t_poly = _transform_polygon(
                    t_col.vertices, t_tf.x, t_tf.y, t_tf.heading, t_phys.size
                )
                result = _sat_collision(s_poly, t_poly, s_tf.x, s_tf.y, t_tf.x, t_tf.y)
                if result is None:
                    continue

                _, _, _, contact_x, contact_y = result

                self._kill(s_ent)
                hit_shaheds.add(s_ent)

                breach_side = self._breach_side(t_tf, contact_x, contact_y)
                self._breach_hull(t_tf, breach_side, breach_count)
                emit_danger_scent(contact_x, contact_y)

                self.events.append(
                    {
                        "type": "explosion",
                        "x": contact_x,
                        "y": contact_y,
                    }
                )
                break

    # ------------------------------------------------------------------
    # Quadcopter kamikaze
    # ------------------------------------------------------------------

    def _quadcopter_kamikaze(
        self,
        quadcopters: list[tuple[int, Transform, VehiclePhysics, Collidable]],
        tankers: list[tuple[int, Transform, VehiclePhysics, Collidable]],
        frigates: list[tuple[int, Transform, VehiclePhysics, Collidable]],
    ) -> None:
        targets = [
            (ent, tf, phys, col, QUADCOPTER_TANKER_BREACHES) for ent, tf, phys, col in tankers
        ] + [(ent, tf, phys, col, QUADCOPTER_FRIGATE_BREACHES) for ent, tf, phys, col in frigates]

        hit_quads: set[int] = set()

        for q_ent, q_tf, q_phys, q_col in quadcopters:
            if q_ent in hit_quads:
                continue
            for t_ent, t_tf, t_phys, t_col, breach_count in targets:
                dx = t_tf.x - q_tf.x
                dy = t_tf.y - q_tf.y
                dist_sq = dx * dx + dy * dy
                br_sum = q_col.bounding_radius * q_phys.size + t_col.bounding_radius * t_phys.size
                if dist_sq > br_sum * br_sum:
                    continue

                q_poly = _transform_polygon(
                    q_col.vertices, q_tf.x, q_tf.y, q_tf.heading, q_phys.size
                )
                t_poly = _transform_polygon(
                    t_col.vertices, t_tf.x, t_tf.y, t_tf.heading, t_phys.size
                )
                result = _sat_collision(q_poly, t_poly, q_tf.x, q_tf.y, t_tf.x, t_tf.y)
                if result is None:
                    continue

                _, _, _, contact_x, contact_y = result

                # Kill the quadcopter
                self._kill(q_ent)
                hit_quads.add(q_ent)

                # Deal HP damage to target
                t_health = esper.component_for_entity(t_ent, Health)
                t_health.hp = max(0, t_health.hp - QUADCOPTER_HP_DAMAGE)
                if t_health.hp <= 0:
                    self._kill(t_ent)
                    self.kills.append(
                        {
                            "victim_type": t_phys.vehicle_type,
                            "cause": "quadcopter",
                        }
                    )

                # Apply hull breaches (tankers flood/list/slow, frigates don't)
                if breach_count > 0:
                    breach_side = self._breach_side(t_tf, contact_x, contact_y)
                    self._breach_hull(t_tf, breach_side, breach_count)
                emit_danger_scent(contact_x, contact_y)

                self.events.append(
                    {
                        "type": "explosion",
                        "x": contact_x,
                        "y": contact_y,
                    }
                )
                break

    # ------------------------------------------------------------------
    # Speedboat weapons
    # ------------------------------------------------------------------

    def _speedboat_attacks(
        self,
        speedboats: list[tuple[int, Transform, VehiclePhysics, Collidable]],
        tankers: list[tuple[int, Transform, VehiclePhysics, Collidable]],
        frigates: list[tuple[int, Transform, VehiclePhysics, Collidable]],
        dt: float,
    ) -> None:
        """Speedboat bow gun + RPG attacks against tankers and frigates."""
        # Prune state for dead/removed speedboats
        active_ids = {ent for ent, _, _, _ in speedboats}
        for eid in [k for k in self._speedboat_weapons if k not in active_ids]:
            del self._speedboat_weapons[eid]

        targets = tankers + frigates

        for sb_ent, sb_tf, _, _ in speedboats:
            state = self._speedboat_weapons.get(sb_ent)
            if state is None:
                state = _SpeedboatWeaponState()
                self._speedboat_weapons[sb_ent] = state

            state.bow_gun_cooldown -= dt
            state.rpg_cooldown -= dt

            cos_h = math.cos(sb_tf.heading)
            sin_h = math.sin(sb_tf.heading)

            # Find closest target within bow gun range (longer of the two weapons)
            best_ent: int | None = None
            best_tf: Transform | None = None
            best_phys: VehiclePhysics | None = None
            best_dist_sq = BOW_GUN_RANGE_SQ
            best_in_forward_arc = False

            for t_ent, t_tf, t_phys, _ in targets:
                dx = t_tf.x - sb_tf.x
                dy = t_tf.y - sb_tf.y
                d_sq = dx * dx + dy * dy
                if d_sq > BOW_GUN_RANGE_SQ:
                    continue
                if d_sq < best_dist_sq:
                    best_dist_sq = d_sq
                    best_ent = t_ent
                    best_tf = t_tf
                    best_phys = t_phys
                    dist = math.sqrt(d_sq)
                    if dist > 0:
                        best_in_forward_arc = (
                            (cos_h * dx + sin_h * dy) / dist > BOW_GUN_ARC_COS
                        )
                    else:
                        best_in_forward_arc = True

            if best_ent is None or best_tf is None or best_phys is None:
                continue

            t_health = esper.component_for_entity(best_ent, Health)

            # Bow gun: forward arc, shorter cooldown, lower damage
            if state.bow_gun_cooldown <= 0 and best_in_forward_arc:
                state.bow_gun_cooldown = BOW_GUN_COOLDOWN
                t_health.hp = max(0, t_health.hp - BOW_GUN_DAMAGE)
                emit_danger_scent(best_tf.x, best_tf.y)
                if t_health.hp <= 0:
                    self._kill(best_ent)
                    self.kills.append(
                        {"victim_type": best_phys.vehicle_type, "cause": "speedboat"}
                    )
                self.events.append(
                    {"type": "explosion", "x": best_tf.x, "y": best_tf.y}
                )

            # RPG: all arcs, longer cooldown, heavy damage + breach
            if (
                state.rpg_cooldown <= 0
                and best_dist_sq <= RPG_RANGE_SQ
                and t_health.hp > 0
            ):
                state.rpg_cooldown = RPG_COOLDOWN
                t_health.hp = max(0, t_health.hp - RPG_DAMAGE)
                emit_danger_scent(best_tf.x, best_tf.y)
                # RPG causes hull breaches on tankers
                if best_phys.vehicle_type == "oil_tanker" and RPG_TANKER_BREACHES > 0:
                    side = self._breach_side(best_tf, sb_tf.x, sb_tf.y)
                    self._breach_hull(best_tf, side, RPG_TANKER_BREACHES)
                if t_health.hp <= 0:
                    self._kill(best_ent)
                    self.kills.append(
                        {"victim_type": best_phys.vehicle_type, "cause": "speedboat"}
                    )
                self.events.append(
                    {"type": "explosion", "x": best_tf.x, "y": best_tf.y}
                )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _breach_side(tf: Transform, cx: float, cy: float) -> float:
        dx = cx - tf.x
        dy = cy - tf.y
        cross = math.cos(tf.heading) * dy - math.sin(tf.heading) * dx
        if cross > 0:
            return 1.0
        if cross < 0:
            return -1.0
        return 0.0

    @staticmethod
    def _breach_hull(tf: Transform, side: float, breach_count: int) -> None:
        from hormuz.systems.physics import BREACH_CLAMP_COUNT

        tf.hull_breaches += breach_count
        tf.breach_side = max(-1.0, min(1.0, tf.breach_side + side / BREACH_CLAMP_COUNT))

    def _kill(self, ent: int) -> None:
        health = esper.component_for_entity(ent, Health)
        health.hp = 0
        if esper.has_component(ent, BotControl):
            esper.remove_component(ent, BotControl)
        if esper.has_component(ent, PlayerControl):
            esper.remove_component(ent, PlayerControl)
        if not esper.has_component(ent, RespawnTimer):
            esper.add_component(ent, RespawnTimer(remaining=3.0))
