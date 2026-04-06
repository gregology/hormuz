import asyncio
import logging
import random
import time
from pathlib import Path

import esper
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

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
from hormuz.generated.vehicles import (
    COLLISION_POLYGONS,
    MAX_HP,
    VEHICLE_PHYSICS,
    VEHICLES,
    WORLD_SPAWNS,
)
from hormuz.map_data import (
    IRAN_SPAWNS,
    PATROL_ZONES,
    random_frigate_gulf_spawn,
    random_frigate_oman_spawn,
    random_oman_spawn,
    random_quadcopter_spawn,
    random_speedboat_spawn,
    random_tanker_spawn,
)
from hormuz.protocol import (
    MSG_INPUT,
    decode_client_message,
    encode_assign_vehicle,
    encode_event,
    encode_full_snapshot,
    encode_war_cost,
)
from hormuz.systems.bot_ai import BotAIProcessor
from hormuz.systems.collision import CollisionProcessor
from hormuz.systems.combat import CombatProcessor
from hormuz.systems.grounding import GroundingProcessor
from hormuz.systems.physics import PhysicsProcessor
from hormuz.systems.spawn import SpawnProcessor

logger = logging.getLogger("hormuz")

app = FastAPI(title="Hormuz", version="0.0.1")

TICK_RATE = 20
TICK_INTERVAL = 1.0 / TICK_RATE

# --- Player connection tracking ---

connections: dict[int, WebSocket] = {}  # connection_id -> websocket
player_entities: dict[int, int] = {}  # connection_id -> entity_id
_next_conn_id = 0

# Game state
game_state = {
    "tick": 0,
    "war_cost_usd": 0,
    "tankers_delivered": 0,
    "tankers_sunk": 0,
    "frigates_sunk": 0,
    "shaheds_intercepted": 0,
    "quadcopters_intercepted": 0,
    "speedboats_sunk": 0,
    "uptime_seconds": 0.0,
}

start_time = time.monotonic()


def _expand_spawn_group(value: int | dict[str, int], vehicle_type: str) -> list[tuple[str, int]]:
    """Expand a spawn group value into (behavior, count) pairs.

    If value is an int, uses the vehicle's default ai_behavior.
    If value is a dict, keys are behavior names and values are counts.
    """
    if isinstance(value, int):
        return [(VEHICLES[vehicle_type].ai_behavior, value)]
    return list(value.items())


def setup_world() -> None:
    """Create all entities and register ECS processors."""
    esper.add_processor(BotAIProcessor(), priority=6)
    esper.add_processor(PhysicsProcessor(), priority=5)
    esper.add_processor(GroundingProcessor(), priority=4)
    esper.add_processor(CombatProcessor(), priority=3)
    esper.add_processor(CollisionProcessor(), priority=2)
    esper.add_processor(SpawnProcessor(), priority=1)

    # --- Oil tankers ---
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

    # --- Shaheds ---
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

    # --- Quadcopters ---
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

    # --- Speedboats ---
    for _ in range(WORLD_SPAWNS["speedboat"]):
        x, y, heading = random_speedboat_spawn()
        esper.create_entity(
            Transform(x=x, y=y, heading=heading),
            VehiclePhysics(**VEHICLE_PHYSICS["speedboat"]),
            Faction("iran"),
            Health(MAX_HP["speedboat"], MAX_HP["speedboat"]),
            Collidable(COLLISION_POLYGONS["speedboat"]),
            BotControl("swarm_attack"),
            SpawnConfig("swarm_attack"),
        )

    # --- Frigates ---
    frigate_spawns = WORLD_SPAWNS["frigate"]
    for behavior, count in _expand_spawn_group(frigate_spawns["gulf"], "frigate"):
        for _ in range(count):
            x, y, heading = random_frigate_gulf_spawn()
            esper.create_entity(
                Transform(x=x, y=y, heading=heading),
                VehiclePhysics(**VEHICLE_PHYSICS["frigate"]),
                Faction("us"),
                Health(MAX_HP["frigate"], MAX_HP["frigate"]),
                Collidable(COLLISION_POLYGONS["frigate"]),
                BotControl(behavior),
                SpawnConfig(behavior),
                PatrolZone(
                    center_x=PATROL_ZONES["strait_west"]["position"][0],
                    center_y=PATROL_ZONES["strait_west"]["position"][1],
                    radius=PATROL_ZONES["strait_west"]["radius"],
                    zone_id="strait_west",
                ),
            )

    for behavior, count in _expand_spawn_group(frigate_spawns["oman"], "frigate"):
        for _ in range(count):
            x, y, heading = random_frigate_oman_spawn()
            esper.create_entity(
                Transform(x=x, y=y, heading=heading),
                VehiclePhysics(**VEHICLE_PHYSICS["frigate"]),
                Faction("us"),
                Health(MAX_HP["frigate"], MAX_HP["frigate"]),
                Collidable(COLLISION_POLYGONS["frigate"]),
                BotControl(behavior),
                SpawnConfig(behavior),
                PatrolZone(
                    center_x=PATROL_ZONES["oman_approach"]["position"][0],
                    center_y=PATROL_ZONES["oman_approach"]["position"][1],
                    radius=PATROL_ZONES["oman_approach"]["radius"],
                    zone_id="oman_approach",
                ),
            )


# --- Networking helpers ---


def build_snapshot() -> bytes:
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
    return encode_full_snapshot(game_state["tick"], entities)


ENEMY_FACTIONS: dict[str, set[str]] = {
    "civilian": {"iran"},
    "iran": {"civilian", "us"},
    "us": {"iran"},
}


def _nearest_enemy_distance(ent: int) -> float:
    """Return distance to the nearest enemy entity. Infinity if no enemies exist."""
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


def _pick_nearest_to_enemy(candidates: list[int]) -> int:
    """Pick the candidate closest to its nearest enemy."""
    return min(candidates, key=_nearest_enemy_distance)


def _assign_entity(conn_id: int, ent: int) -> None:
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
    player_entities[conn_id] = ent


def _teleport_to_spawn(ent: int) -> None:
    """Teleport an entity to a safe spawn point based on its vehicle type."""
    tf = esper.component_for_entity(ent, Transform)
    phys = esper.component_for_entity(ent, VehiclePhysics)
    if phys.vehicle_type == "shahed":
        spawn = random.choice(IRAN_SPAWNS)
        tf.x, tf.y = float(spawn["position"][0]), float(spawn["position"][1])
        tf.heading = spawn["heading"]
    elif phys.vehicle_type == "quadcopter":
        tanker_positions: list[tuple[float, float]] = []
        for _, (t_tf, t_phys, t_health) in esper.get_components(Transform, VehiclePhysics, Health):
            if t_phys.vehicle_type == "oil_tanker" and t_health.hp > 0:
                tanker_positions.append((t_tf.x, t_tf.y))
        tf.x, tf.y, tf.heading = random_quadcopter_spawn(tanker_positions)
    elif phys.vehicle_type == "speedboat":
        tf.x, tf.y, tf.heading = random_speedboat_spawn()
    else:
        tf.x, tf.y, tf.heading = random_tanker_spawn()
    tf.speed = 0.0
    tf.drift = 0.0
    tf.angular_velocity = 0.0
    battery = esper.try_component(ent, Battery)
    if battery is not None:
        battery.charge = 100.0


def assign_vehicle_to_player(conn_id: int, teleport: bool = False) -> int | None:
    """Find a bot-controlled entity and assign it to a human player.

    Picks a random vehicle type (equal probability, limited to types with living
    bots), then within that type picks the bot closest to its nearest enemy.
    """
    # Group living bots by vehicle type
    by_type: dict[str, list[int]] = {}
    for ent, (bot, phys, health) in esper.get_components(BotControl, VehiclePhysics, Health):
        if health.hp > 0:
            by_type.setdefault(phys.vehicle_type, []).append(ent)
    if not by_type:
        return None
    vehicle_type = random.choice(list(by_type.keys()))
    ent = _pick_nearest_to_enemy(by_type[vehicle_type])
    _assign_entity(conn_id, ent)
    if teleport:
        _teleport_to_spawn(ent)
    return ent


def assign_vehicle_type_to_player(conn_id: int, vehicle_type: str) -> int | None:
    """Find a bot-controlled entity of the requested type and assign it to a human player.

    Picks randomly among matching vehicles, weighted toward the strait.
    Teleports the vehicle to a safe spawn so the player starts fresh.
    """
    if vehicle_type not in ("oil_tanker", "shahed", "frigate", "quadcopter", "speedboat"):
        return None

    candidates = [
        ent
        for ent, (bot, phys, health) in esper.get_components(BotControl, VehiclePhysics, Health)
        if health.hp > 0 and phys.vehicle_type == vehicle_type
    ]
    if not candidates:
        return assign_vehicle_to_player(conn_id, teleport=True)

    ent = _pick_nearest_to_enemy(candidates)
    _assign_entity(conn_id, ent)
    _teleport_to_spawn(ent)
    return ent


def release_vehicle(conn_id: int) -> None:
    """Return a player's vehicle to bot control."""
    ent = player_entities.pop(conn_id, None)
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


def apply_input(conn_id: int, msg: dict) -> None:
    """Decode input message and update player's vehicle input."""
    ent = player_entities.get(conn_id)
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


async def broadcast(data: bytes) -> None:
    """Send data to all connected clients, removing dead connections."""
    if not connections:
        return
    dead: list[int] = []
    tasks = []
    for conn_id, ws in connections.items():
        tasks.append((conn_id, ws.send_bytes(data)))
    for conn_id, coro in tasks:
        try:
            await coro
        except Exception:
            dead.append(conn_id)
    for conn_id in dead:
        connections.pop(conn_id, None)
        release_vehicle(conn_id)


# --- Game loop ---


async def game_loop() -> None:
    """Main server game loop running at TICK_RATE Hz."""
    while True:
        t0 = time.monotonic()

        game_state["tick"] += 1
        game_state["uptime_seconds"] = round(time.monotonic() - start_time, 1)

        esper.process(dt=TICK_INTERVAL)

        # Update stats from processors
        spawn_proc = esper.get_processor(SpawnProcessor)
        combat_proc = esper.get_processor(CombatProcessor)
        physics_proc = esper.get_processor(PhysicsProcessor)
        game_state["tankers_delivered"] = spawn_proc.tankers_delivered

        # Count kills by victim type (combat kills + flood kills)
        for kill in combat_proc.kills:
            vtype = kill["victim_type"]
            if vtype == "oil_tanker":
                game_state["tankers_sunk"] += 1
            elif vtype == "frigate":
                game_state["frigates_sunk"] += 1
            elif vtype == "shahed" and kill["cause"] == "autocannon":
                game_state["shaheds_intercepted"] += 1
            elif vtype == "quadcopter" and kill["cause"] == "autocannon":
                game_state["quadcopters_intercepted"] += 1
            elif vtype == "speedboat":
                game_state["speedboats_sunk"] += 1
        for vtype in physics_proc.flood_kills:
            if vtype == "oil_tanker":
                game_state["tankers_sunk"] += 1
            elif vtype == "frigate":
                game_state["frigates_sunk"] += 1

        # War cost = sum of cost_usd for all destroyed vehicles + delivered cargo value
        tanker_cost = VEHICLES["oil_tanker"].cost_usd
        game_state["war_cost_usd"] = (
            game_state["tankers_sunk"] * tanker_cost
            + game_state["frigates_sunk"] * VEHICLES["frigate"].cost_usd
            + game_state["shaheds_intercepted"] * VEHICLES["shahed"].cost_usd
            + game_state["quadcopters_intercepted"] * VEHICLES["quadcopter"].cost_usd
            + game_state["speedboats_sunk"] * VEHICLES["speedboat"].cost_usd
            + spawn_proc.tankers_delivered * tanker_cost
        )

        # Clean up players whose vehicles were killed — auto-assign a random new one
        for conn_id, ent in list(player_entities.items()):
            if not esper.entity_exists(ent):
                player_entities.pop(conn_id, None)
                continue
            health = esper.try_component(ent, Health)
            if health and health.hp <= 0 and not esper.has_component(ent, PlayerControl):
                player_entities.pop(conn_id, None)

                if conn_id in connections:
                    new_ent = assign_vehicle_to_player(conn_id, teleport=True)
                    if new_ent is not None:
                        new_phys = esper.component_for_entity(new_ent, VehiclePhysics)
                        try:
                            await connections[conn_id].send_bytes(
                                encode_assign_vehicle(new_ent, new_phys.vehicle_type)
                            )
                        except Exception:
                            pass

        # Broadcast snapshot to all clients
        snapshot = build_snapshot()
        await broadcast(snapshot)

        # Broadcast events (explosions, deliveries, projectiles)
        for event in combat_proc.events:
            if event["type"] == "projectile":
                await broadcast(
                    encode_event(
                        "projectile",
                        event["x"],
                        event["y"],
                        event["target_x"],
                        event["target_y"],
                    )
                )
            else:
                await broadcast(encode_event(event["type"], event["x"], event["y"]))
        for event in spawn_proc.events:
            await broadcast(encode_event(event["type"], event["x"], event["y"]))

        # Broadcast stats every second (every 20 ticks)
        if game_state["tick"] % TICK_RATE == 0:
            await broadcast(
                encode_war_cost(
                    game_state["war_cost_usd"],
                    game_state["tankers_delivered"],
                    game_state["tankers_sunk"],
                    game_state["frigates_sunk"],
                    game_state["shaheds_intercepted"],
                    game_state["quadcopters_intercepted"],
                    game_state["speedboats_sunk"],
                    len(player_entities),
                )
            )

        elapsed = time.monotonic() - t0
        await asyncio.sleep(max(0, TICK_INTERVAL - elapsed))


# --- FastAPI endpoints ---


@app.on_event("startup")
async def startup() -> None:
    setup_world()
    asyncio.create_task(game_loop())


@app.get("/api/status")
async def status() -> JSONResponse:
    return JSONResponse(
        {
            "game": "hormuz",
            "version": "0.0.1",
            "tick_rate": TICK_RATE,
            "tick": game_state["tick"],
            "war_cost_usd": game_state["war_cost_usd"],
            "tankers_delivered": game_state["tankers_delivered"],
            "tankers_sunk": game_state["tankers_sunk"],
            "frigates_sunk": game_state["frigates_sunk"],
            "shaheds_intercepted": game_state["shaheds_intercepted"],
            "quadcopters_intercepted": game_state["quadcopters_intercepted"],
            "speedboats_sunk": game_state["speedboats_sunk"],
            "entities": len(list(esper.get_component(Transform))),
            "players": len(player_entities),
            "uptime_seconds": game_state["uptime_seconds"],
        }
    )


@app.get("/api/entities")
async def entities() -> JSONResponse:
    """Debug endpoint — dump all entity positions."""
    result = []
    for ent, (tf, phys) in esper.get_components(Transform, VehiclePhysics):
        result.append(
            {
                "id": ent,
                "type": phys.vehicle_type,
                "x": round(tf.x, 1),
                "y": round(tf.y, 1),
                "heading": round(tf.heading, 3),
                "speed": round(tf.speed, 2),
            }
        )
    return JSONResponse(result)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    global _next_conn_id
    await websocket.accept()

    conn_id = _next_conn_id
    _next_conn_id += 1
    connections[conn_id] = websocket

    # Assign a vehicle to this player
    assigned = assign_vehicle_to_player(conn_id)
    if assigned is not None:
        phys = esper.component_for_entity(assigned, VehiclePhysics)
        await websocket.send_bytes(encode_assign_vehicle(assigned, phys.vehicle_type))

    # Send full snapshot
    await websocket.send_bytes(build_snapshot())

    # Send current stats
    await websocket.send_bytes(
        encode_war_cost(
            game_state["war_cost_usd"],
            game_state["tankers_delivered"],
            game_state["tankers_sunk"],
            game_state["frigates_sunk"],
            game_state["shaheds_intercepted"],
            game_state["quadcopters_intercepted"],
            game_state["speedboats_sunk"],
            len(player_entities),
        )
    )

    try:
        while True:
            data = await websocket.receive_bytes()
            msg = decode_client_message(data)
            if msg["type"] == MSG_INPUT:
                apply_input(conn_id, msg)
    except WebSocketDisconnect:
        connections.pop(conn_id, None)
        release_vehicle(conn_id)


# --- Static file serving (production: serve built client) ---

CLIENT_DIST = Path(__file__).parent.parent.parent.parent / "client" / "dist"
if CLIENT_DIST.exists():
    app.mount("/", StaticFiles(directory=str(CLIENT_DIST), html=True), name="static")
