"""Game server — encapsulates all game state and ECS world management.

Extracted from main.py to make the game logic testable, reusable,
and free from global mutable state.
"""

import random
import time

import esper

from hormuz.components import (
    Battery,
    BotControl,
    CargoState,
    Collidable,
    Faction,
    Health,
    PatrolZone,
    PlayerControl,
    SpawnConfig,
    Transform,
    VehiclePhysics,
)
from hormuz.entity_helpers import teleport_to_spawn
from hormuz.generated.vehicles import (
    COLLISION_POLYGONS,
    MAX_HP,
    VEHICLE_PHYSICS,
    VEHICLES,
    WORLD_SPAWNS,
)
from hormuz.map_data import (
    IRAN_SPAWNS,
    random_oman_spawn,
    random_quadcopter_spawn,
    random_tanker_spawn,
)
from hormuz.protocol import (
    encode_full_snapshot,
)
from hormuz.systems.bot_ai import BotAIProcessor
from hormuz.systems.collision import CollisionProcessor
from hormuz.systems.combat import CombatProcessor
from hormuz.systems.grounding import GroundingProcessor
from hormuz.systems.physics import PhysicsProcessor
from hormuz.systems.spawn import SpawnProcessor

TICK_RATE = 20
TICK_INTERVAL = 1.0 / TICK_RATE

ENEMY_FACTIONS: dict[str, set[str]] = {
    "civilian": {"iran"},
    "iran": {"civilian", "us"},
    "us": {"iran"},
}

# Valid player-selectable vehicle types
PLAYABLE_VEHICLE_TYPES = frozenset(("oil_tanker", "shahed", "frigate", "quadcopter"))


def _expand_spawn_group(
    value: int | dict[str, int], vehicle_type: str
) -> list[tuple[str, int]]:
    """Expand a spawn group value into (behavior, count) pairs."""
    if isinstance(value, int):
        return [(VEHICLES[vehicle_type].ai_behavior, value)]
    return list(value.items())


class GameServer:
    """Encapsulates all game state: ECS world, connections, statistics."""

    def __init__(self) -> None:
        self.player_entities: dict[int, int] = {}  # connection_id -> entity_id
        self._next_conn_id = 0

        self.game_state = {
            "tick": 0,
            "war_cost_usd": 0,
            "tankers_delivered": 0,
            "tankers_sunk": 0,
            "frigates_sunk": 0,
            "shaheds_intercepted": 0,
            "quadcopters_intercepted": 0,
            "uptime_seconds": 0.0,
        }

        self.start_time = time.monotonic()

    def next_conn_id(self) -> int:
        """Allocate a new connection ID."""
        conn_id = self._next_conn_id
        self._next_conn_id += 1
        return conn_id

    # ------------------------------------------------------------------
    # World setup
    # ------------------------------------------------------------------

    def setup_world(self) -> None:
        """Create all entities and register ECS processors."""
        esper.add_processor(BotAIProcessor(), priority=6)
        esper.add_processor(PhysicsProcessor(), priority=5)
        esper.add_processor(GroundingProcessor(), priority=4)
        esper.add_processor(CombatProcessor(), priority=3)
        esper.add_processor(CollisionProcessor(), priority=2)
        esper.add_processor(SpawnProcessor(), priority=1)

        self._spawn_tankers()
        self._spawn_shaheds()
        self._spawn_quadcopters()
        self._spawn_frigates()

    def _spawn_tankers(self) -> None:
        tanker_spawns = WORLD_SPAWNS["oil_tanker"]
        for behavior, count in _expand_spawn_group(tanker_spawns["outbound"], "oil_tanker"):
            for _ in range(count):
                x, y, heading = random_tanker_spawn()
                esper.create_entity(
                    Transform(x=x, y=y, heading=heading),
                    VehiclePhysics(**VEHICLE_PHYSICS["oil_tanker"]),
                    Faction("civilian"),
                    Health(MAX_HP["oil_tanker"], MAX_HP["oil_tanker"]),
                    Collidable(COLLISION_POLYGONS["oil_tanker"]),
                    BotControl(behavior),
                    SpawnConfig(behavior),
                    CargoState(loaded=True, destination="oman"),
                )

        for behavior, count in _expand_spawn_group(tanker_spawns["inbound"], "oil_tanker"):
            for _ in range(count):
                x, y, heading = random_oman_spawn()
                esper.create_entity(
                    Transform(x=x, y=y, heading=heading),
                    VehiclePhysics(**VEHICLE_PHYSICS["oil_tanker"]),
                    Faction("civilian"),
                    Health(MAX_HP["oil_tanker"], MAX_HP["oil_tanker"]),
                    Collidable(COLLISION_POLYGONS["oil_tanker"]),
                    BotControl(behavior),
                    SpawnConfig(behavior),
                    CargoState(loaded=False, destination="gulf"),
                )

    def _spawn_shaheds(self) -> None:
        for i in range(WORLD_SPAWNS["shahed"]):
            spawn = IRAN_SPAWNS[i % len(IRAN_SPAWNS)]
            x, y = spawn["position"]
            esper.create_entity(
                Transform(x=float(x), y=float(y), heading=spawn["heading"]),
                VehiclePhysics(**VEHICLE_PHYSICS["shahed"]),
                Faction("iran"),
                Health(MAX_HP["shahed"], MAX_HP["shahed"]),
                Collidable(COLLISION_POLYGONS["shahed"]),
                BotControl("shahed_intercept"),
                SpawnConfig("shahed_intercept"),
                Battery(),
            )

    def _spawn_quadcopters(self) -> None:
        tanker_positions: list[tuple[float, float]] = []
        for _, (tf, phys) in esper.get_components(Transform, VehiclePhysics):
            if phys.vehicle_type == "oil_tanker":
                tanker_positions.append((tf.x, tf.y))
        for i in range(WORLD_SPAWNS["quadcopter"]):
            x, y, heading = random_quadcopter_spawn(tanker_positions)
            esper.create_entity(
                Transform(x=x, y=y, heading=heading),
                VehiclePhysics(**VEHICLE_PHYSICS["quadcopter"]),
                Faction("iran"),
                Health(MAX_HP["quadcopter"], MAX_HP["quadcopter"]),
                Collidable(COLLISION_POLYGONS["quadcopter"]),
                BotControl("quadcopter_intercept"),
                SpawnConfig("quadcopter_intercept"),
                Battery(),
            )

    def _spawn_frigates(self) -> None:
        frigate_spawns = WORLD_SPAWNS["frigate"]
        for behavior, count in _expand_spawn_group(frigate_spawns["gulf"], "frigate"):
            for _ in range(count):
                x, y, heading = random_tanker_spawn()
                esper.create_entity(
                    Transform(x=x, y=y, heading=heading),
                    VehiclePhysics(**VEHICLE_PHYSICS["frigate"]),
                    Faction("us"),
                    Health(MAX_HP["frigate"], MAX_HP["frigate"]),
                    Collidable(COLLISION_POLYGONS["frigate"]),
                    BotControl(behavior),
                    SpawnConfig(behavior),
                    PatrolZone(
                        center_x=71300.0,
                        center_y=46800.0,
                        radius=15000.0,
                        zone_id="strait_west",
                    ),
                )

        for behavior, count in _expand_spawn_group(frigate_spawns["oman"], "frigate"):
            for _ in range(count):
                x, y, heading = random_oman_spawn()
                esper.create_entity(
                    Transform(x=x, y=y, heading=heading),
                    VehiclePhysics(**VEHICLE_PHYSICS["frigate"]),
                    Faction("us"),
                    Health(MAX_HP["frigate"], MAX_HP["frigate"]),
                    Collidable(COLLISION_POLYGONS["frigate"]),
                    BotControl(behavior),
                    SpawnConfig(behavior),
                    PatrolZone(
                        center_x=112850.0,
                        center_y=62424.0,
                        radius=15000.0,
                        zone_id="oman_approach",
                    ),
                )

    # ------------------------------------------------------------------
    # Snapshot
    # ------------------------------------------------------------------

    def build_snapshot(self) -> bytes:
        """Build a full snapshot of all alive entities."""
        entities = []
        for ent, (tf, phys, health, faction) in esper.get_components(
            Transform, VehiclePhysics, Health, Faction
        ):
            battery = esper.try_component(ent, Battery)
            battery_pct = round(battery.charge, 1) if battery else -1.0
            entities.append(
                (
                    ent,
                    phys.vehicle_type,
                    faction.name,
                    tf.x,
                    tf.y,
                    tf.heading,
                    tf.speed,
                    tf.drift,
                    tf.angular_velocity,
                    health.hp,
                    tf.flood_level,
                    tf.list_angle,
                    battery_pct,
                )
            )
        return encode_full_snapshot(self.game_state["tick"], entities)

    # ------------------------------------------------------------------
    # Vehicle assignment
    # ------------------------------------------------------------------

    def _nearest_enemy_distance(self, ent: int) -> float:
        """Return squared distance to the nearest enemy entity."""
        tf = esper.component_for_entity(ent, Transform)
        faction = esper.component_for_entity(ent, Faction)
        enemies = ENEMY_FACTIONS.get(faction.name, set())
        best = float("inf")
        for _, (e_tf, e_faction, e_health) in esper.get_components(Transform, Faction, Health):
            if e_health.hp > 0 and e_faction.name in enemies:
                dx = tf.x - e_tf.x
                dy = tf.y - e_tf.y
                dist = dx * dx + dy * dy
                if dist < best:
                    best = dist
        return best

    def _pick_nearest_to_enemy(self, candidates: list[int]) -> int:
        """Pick the candidate closest to its nearest enemy."""
        return min(candidates, key=self._nearest_enemy_distance)

    def _assign_entity(self, conn_id: int, ent: int) -> None:
        """Hand an entity from bot control to a player."""
        waypoint_index = 0
        bot = esper.try_component(ent, BotControl)
        if bot is not None:
            waypoint_index = bot.waypoint_index
        esper.remove_component(ent, BotControl)

        phys = esper.component_for_entity(ent, VehiclePhysics)
        autopilot_default = phys.vehicle_type == "oil_tanker"
        esper.add_component(
            ent,
            PlayerControl(
                connection_id=conn_id,
                autopilot=autopilot_default,
                waypoint_index=waypoint_index,
            ),
        )
        self.player_entities[conn_id] = ent

    def assign_vehicle_to_player(self, conn_id: int, teleport: bool = False) -> int | None:
        """Find a bot-controlled entity and assign it to a human player."""
        by_type: dict[str, list[int]] = {}
        for ent, (bot, phys, health) in esper.get_components(BotControl, VehiclePhysics, Health):
            if health.hp > 0:
                by_type.setdefault(phys.vehicle_type, []).append(ent)
        if not by_type:
            return None
        vehicle_type = random.choice(list(by_type.keys()))
        ent = self._pick_nearest_to_enemy(by_type[vehicle_type])
        self._assign_entity(conn_id, ent)
        if teleport:
            teleport_to_spawn(ent)
        return ent

    def assign_vehicle_type_to_player(self, conn_id: int, vehicle_type: str) -> int | None:
        """Find a bot-controlled entity of the requested type and assign it."""
        if vehicle_type not in PLAYABLE_VEHICLE_TYPES:
            return None

        candidates = [
            ent
            for ent, (bot, phys, health) in esper.get_components(BotControl, VehiclePhysics, Health)
            if health.hp > 0 and phys.vehicle_type == vehicle_type
        ]
        if not candidates:
            return self.assign_vehicle_to_player(conn_id, teleport=True)

        ent = self._pick_nearest_to_enemy(candidates)
        self._assign_entity(conn_id, ent)
        teleport_to_spawn(ent)
        return ent

    def release_vehicle(self, conn_id: int) -> None:
        """Return a player's vehicle to bot control."""
        ent = self.player_entities.pop(conn_id, None)
        if ent is None or not esper.entity_exists(ent):
            return
        waypoint_index = 0
        if esper.has_component(ent, PlayerControl):
            pc = esper.component_for_entity(ent, PlayerControl)
            waypoint_index = pc.waypoint_index
            esper.remove_component(ent, PlayerControl)
        if not esper.has_component(ent, BotControl):
            spawn_cfg = esper.try_component(ent, SpawnConfig)
            if spawn_cfg is not None:
                behavior = spawn_cfg.behavior
            else:
                phys = esper.component_for_entity(ent, VehiclePhysics)
                behavior = VEHICLES[phys.vehicle_type].ai_behavior
            esper.add_component(ent, BotControl(behavior, waypoint_index=waypoint_index))

    # ------------------------------------------------------------------
    # Input handling
    # ------------------------------------------------------------------

    def apply_input(self, conn_id: int, msg: dict) -> None:
        """Decode input message and update player's vehicle input."""
        ent = self.player_entities.get(conn_id)
        if ent is None or not esper.entity_exists(ent):
            return
        pc = esper.try_component(ent, PlayerControl)
        if pc is None:
            return

        keys = msg["keys"]
        throttle_float = msg.get("throttle_float", 0.0)
        autopilot = msg.get("autopilot", False)

        phys = esper.component_for_entity(ent, VehiclePhysics)

        # Decode rudder from bitmask: bit2=A/Left, bit3=D/Right
        left = 1.0 if keys & 0x04 else 0.0
        right = 1.0 if keys & 0x08 else 0.0
        pc.rudder = right - left

        if phys.vehicle_type in ("shahed", "quadcopter"):
            # Drones use hold-to-move (W/S from bitmask)
            fwd = 1.0 if keys & 0x01 else 0.0
            rev = 1.0 if keys & 0x02 else 0.0
            pc.throttle = fwd - rev
            pc.autopilot = False

            # Jamming — shaheds lose steering near frigates (quadcopters are autonomous)
            if pc.rudder != 0.0 and phys.vehicle_type == "shahed":
                from hormuz.systems.combat import JAM_RADIUS_SQ

                tf = esper.component_for_entity(ent, Transform)
                for _, (f_tf, f_phys, f_health) in esper.get_components(
                    Transform, VehiclePhysics, Health
                ):
                    if f_phys.vehicle_type == "frigate" and f_health.hp > 0:
                        dx = f_tf.x - tf.x
                        dy = f_tf.y - tf.y
                        if dx * dx + dy * dy < JAM_RADIUS_SQ:
                            pc.rudder = 0.0
                            break
        else:
            # Ships use stepped throttle float from client
            pc.throttle = max(-1.0, min(1.0, throttle_float))
            # Autopilot only for tankers
            pc.autopilot = autopilot if phys.vehicle_type == "oil_tanker" else False

    # ------------------------------------------------------------------
    # Tick
    # ------------------------------------------------------------------

    def tick(self) -> None:
        """Advance the game by one tick (ECS processing + stats update)."""
        self.game_state["tick"] += 1
        self.game_state["uptime_seconds"] = round(time.monotonic() - self.start_time, 1)

        esper.process(dt=TICK_INTERVAL)

        # Update stats from processors
        spawn_proc = esper.get_processor(SpawnProcessor)
        combat_proc = esper.get_processor(CombatProcessor)
        physics_proc = esper.get_processor(PhysicsProcessor)
        self.game_state["tankers_delivered"] = spawn_proc.tankers_delivered

        # Count kills by victim type (combat kills + flood kills)
        for kill in combat_proc.kills:
            vtype = kill["victim_type"]
            if vtype == "oil_tanker":
                self.game_state["tankers_sunk"] += 1
            elif vtype == "frigate":
                self.game_state["frigates_sunk"] += 1
            elif vtype == "shahed" and kill["cause"] == "autocannon":
                self.game_state["shaheds_intercepted"] += 1
            elif vtype == "quadcopter" and kill["cause"] == "autocannon":
                self.game_state["quadcopters_intercepted"] += 1
        for vtype in physics_proc.flood_kills:
            if vtype == "oil_tanker":
                self.game_state["tankers_sunk"] += 1
            elif vtype == "frigate":
                self.game_state["frigates_sunk"] += 1

        # War cost = sum of cost_usd for all destroyed vehicles + delivered cargo value
        tanker_cost = VEHICLES["oil_tanker"].cost_usd
        self.game_state["war_cost_usd"] = (
            self.game_state["tankers_sunk"] * tanker_cost
            + self.game_state["frigates_sunk"] * VEHICLES["frigate"].cost_usd
            + self.game_state["shaheds_intercepted"] * VEHICLES["shahed"].cost_usd
            + self.game_state["quadcopters_intercepted"] * VEHICLES["quadcopter"].cost_usd
            + spawn_proc.tankers_delivered * tanker_cost
        )

    def get_dead_player_entities(self) -> list[int]:
        """Return connection IDs whose vehicles were killed."""
        dead: list[int] = []
        for conn_id, ent in list(self.player_entities.items()):
            if not esper.entity_exists(ent):
                self.player_entities.pop(conn_id, None)
                dead.append(conn_id)
                continue
            health = esper.try_component(ent, Health)
            if health and health.hp <= 0 and not esper.has_component(ent, PlayerControl):
                self.player_entities.pop(conn_id, None)
                dead.append(conn_id)
        return dead
