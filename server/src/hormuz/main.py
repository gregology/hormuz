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
    BotControl,
    CargoState,
    Collidable,
    Faction,
    Health,
    PatrolZone,
    PlayerControl,
    Transform,
    VehiclePhysics,
)
from hormuz.generated.vehicles import VEHICLES
from hormuz.map_data import (
    IRAN_SPAWNS,
    STRAIT_CENTER,
    random_oman_spawn,
    random_quadcopter_spawn,
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
from hormuz.systems.collision import COLLISION_POLYGONS, CollisionProcessor
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
    "uptime_seconds": 0.0,
}

start_time = time.monotonic()

# --- Vehicle physics params (match client factory functions exactly) ---

OIL_TANKER_PHYSICS = dict(
    vehicle_type="oil_tanker",
    max_speed=15.0,
    acceleration=2.0,
    drag=0.97,
    turn_rate=0.0,
    drift_factor=0.0,
    lateral_drag=0.45,
    min_turn_fraction=0.0,
    cruise_speed=0.0,
    airborne=False,
    size=220.0,
    angular_drag=0.30,
    mass=2200.0,
    engine_power=4400.0,
    drag_coefficient=4400.0 / (15.0 * 15.0),
    propeller_offset=-0.4,
    rudder_max_angle=0.6,
    moment_of_inertia=3600000.0,
    rudder_flow_coefficient=0.5 * 4400.0 / (15.0 * 15.0),
)

SHAHED_PHYSICS = dict(
    vehicle_type="shahed",
    max_speed=80.0,
    acceleration=10.0,
    drag=0.95,
    turn_rate=0.5,
    drift_factor=0.02,
    lateral_drag=0.1,
    min_turn_fraction=1.0,
    cruise_speed=68.0,
    airborne=True,
    size=4.0,
    angular_drag=0.10,
    mass=40.0,
    engine_power=400.0,
    drag_coefficient=400.0 / (80.0 * 80.0),
    propeller_offset=0.0,
    rudder_max_angle=0.0,
    moment_of_inertia=0.0,
    rudder_flow_coefficient=0.0,
)

FRIGATE_PHYSICS = dict(
    vehicle_type="frigate",
    max_speed=20.0,
    acceleration=2.0,
    drag=0.95,
    turn_rate=0.0,
    drift_factor=0.0,
    lateral_drag=0.2,
    min_turn_fraction=0.0,
    cruise_speed=0.0,
    airborne=False,
    size=100.0,
    angular_drag=0.25,
    mass=1000.0,
    engine_power=5000.0,
    drag_coefficient=5000.0 / (20.0 * 20.0),
    propeller_offset=-0.4,
    rudder_max_angle=0.6,
    moment_of_inertia=435000.0,
    rudder_flow_coefficient=0.5 * 5000.0 / (20.0 * 20.0),
)

QUADCOPTER_PHYSICS = dict(
    vehicle_type="quadcopter",
    max_speed=22.0,
    acceleration=8.0,
    drag=0.95,
    turn_rate=4.0,
    drift_factor=0.01,
    lateral_drag=0.05,
    min_turn_fraction=1.0,
    cruise_speed=0.0,
    airborne=True,
    size=2.0,
    angular_drag=0.08,
    mass=20.0,
    engine_power=360.0,
    drag_coefficient=360.0 / (22.0 * 22.0),
    propeller_offset=0.0,
    rudder_max_angle=0.0,
    moment_of_inertia=0.0,
    rudder_flow_coefficient=0.0,
)


def setup_world() -> None:
    """Create all entities and register ECS processors."""
    esper.add_processor(BotAIProcessor(), priority=6)
    esper.add_processor(PhysicsProcessor(), priority=5)
    esper.add_processor(GroundingProcessor(), priority=4)
    esper.add_processor(CombatProcessor(), priority=3)
    esper.add_processor(CollisionProcessor(), priority=2)
    esper.add_processor(SpawnProcessor(), priority=1)

    # Spawn 10 loaded tankers heading outbound (Persian Gulf -> Oman)
    for i in range(10):
        x, y, heading = random_tanker_spawn()
        esper.create_entity(
            Transform(x=x, y=y, heading=heading),
            VehiclePhysics(**OIL_TANKER_PHYSICS),
            Faction("civilian"),
            Health(100, 100),
            Collidable(COLLISION_POLYGONS["oil_tanker"]),
            BotControl("tanker_transit"),
            CargoState(loaded=True, destination="oman"),
        )

    # Spawn 10 empty tankers heading inbound (Oman -> Persian Gulf)
    for i in range(10):
        x, y, heading = random_oman_spawn()
        esper.create_entity(
            Transform(x=x, y=y, heading=heading),
            VehiclePhysics(**OIL_TANKER_PHYSICS),
            Faction("civilian"),
            Health(100, 100),
            Collidable(COLLISION_POLYGONS["oil_tanker"]),
            BotControl("tanker_transit"),
            CargoState(loaded=False, destination="gulf"),
        )

    # Spawn 5 shaheds
    for i in range(5):
        spawn = IRAN_SPAWNS[i % len(IRAN_SPAWNS)]
        x, y = spawn["position"]
        esper.create_entity(
            Transform(x=float(x), y=float(y), heading=spawn["heading"]),
            VehiclePhysics(**SHAHED_PHYSICS),
            Faction("iran"),
            Health(10, 10),
            Collidable(COLLISION_POLYGONS["shahed"]),
            BotControl("shahed_intercept"),
        )

    # Spawn 10 quadcopters near tankers (closest launch site, scattered)
    tanker_positions: list[tuple[float, float]] = []
    for _, (tf, phys) in esper.get_components(Transform, VehiclePhysics):
        if phys.vehicle_type == "oil_tanker":
            tanker_positions.append((tf.x, tf.y))
    for i in range(10):
        x, y, heading = random_quadcopter_spawn(tanker_positions)
        esper.create_entity(
            Transform(x=x, y=y, heading=heading),
            VehiclePhysics(**QUADCOPTER_PHYSICS),
            Faction("iran"),
            Health(5, 5),
            Collidable(COLLISION_POLYGONS["quadcopter"]),
            BotControl("quadcopter_intercept"),
        )

    # Spawn 3 frigates on Persian Gulf side
    for i in range(3):
        x, y, heading = random_tanker_spawn()
        esper.create_entity(
            Transform(x=x, y=y, heading=heading),
            VehiclePhysics(**FRIGATE_PHYSICS),
            Faction("us"),
            Health(300, 300),
            Collidable(COLLISION_POLYGONS["frigate"]),
            BotControl("escort"),
            PatrolZone(
                center_x=71300.0, center_y=46800.0,
                radius=15000.0, zone_id="strait_west",
            ),
        )

    # Spawn 2 frigates on Gulf of Oman side
    for i in range(2):
        x, y, heading = random_oman_spawn()
        esper.create_entity(
            Transform(x=x, y=y, heading=heading),
            VehiclePhysics(**FRIGATE_PHYSICS),
            Faction("us"),
            Health(300, 300),
            Collidable(COLLISION_POLYGONS["frigate"]),
            BotControl("escort"),
            PatrolZone(
                center_x=112850.0, center_y=62424.0,
                radius=15000.0, zone_id="oman_approach",
            ),
        )


# --- Networking helpers ---


def build_snapshot() -> bytes:
    """Build a full snapshot of all alive entities."""
    entities = []
    for ent, (tf, phys, health, faction) in esper.get_components(
        Transform, VehiclePhysics, Health, Faction
    ):
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
            )
        )
    return encode_full_snapshot(game_state["tick"], entities)


def _proximity_weight(ent: int) -> float:
    """Weight for random selection: closer to the strait = higher weight."""
    tf = esper.component_for_entity(ent, Transform)
    dx = tf.x - STRAIT_CENTER[0]
    dy = tf.y - STRAIT_CENTER[1]
    dist = (dx * dx + dy * dy) ** 0.5
    # Inverse distance weighting — cap minimum to avoid division by near-zero
    return 1.0 / max(dist, 500.0)


def _pick_weighted(candidates: list[int]) -> int:
    """Pick a random entity from candidates, weighted by strait proximity."""
    weights = [_proximity_weight(ent) for ent in candidates]
    return random.choices(candidates, weights=weights, k=1)[0]


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
        for _, (t_tf, t_phys, t_health) in esper.get_components(
            Transform, VehiclePhysics, Health
        ):
            if t_phys.vehicle_type == "oil_tanker" and t_health.hp > 0:
                tanker_positions.append((t_tf.x, t_tf.y))
        tf.x, tf.y, tf.heading = random_quadcopter_spawn(tanker_positions)
    else:
        tf.x, tf.y, tf.heading = random_tanker_spawn()
    tf.speed = 0.0
    tf.drift = 0.0
    tf.angular_velocity = 0.0


def assign_vehicle_to_player(conn_id: int, teleport: bool = False) -> int | None:
    """Find a bot-controlled entity and assign it to a human player.

    Picks randomly, weighted toward vehicles closer to the strait.
    If teleport is True, moves the vehicle to a safe spawn point.
    """
    candidates = [
        ent
        for ent, (bot, phys, health) in esper.get_components(
            BotControl, VehiclePhysics, Health
        )
        if health.hp > 0
    ]
    if not candidates:
        return None
    ent = _pick_weighted(candidates)
    _assign_entity(conn_id, ent)
    if teleport:
        _teleport_to_spawn(ent)
    return ent


def assign_vehicle_type_to_player(conn_id: int, vehicle_type: str) -> int | None:
    """Find a bot-controlled entity of the requested type and assign it to a human player.

    Picks randomly among matching vehicles, weighted toward the strait.
    Teleports the vehicle to a safe spawn so the player starts fresh.
    """
    if vehicle_type not in ("oil_tanker", "shahed", "frigate", "quadcopter"):
        return None

    candidates = [
        ent
        for ent, (bot, phys, health) in esper.get_components(
            BotControl, VehiclePhysics, Health
        )
        if health.hp > 0 and phys.vehicle_type == vehicle_type
    ]
    if not candidates:
        return assign_vehicle_to_player(conn_id, teleport=True)

    ent = _pick_weighted(candidates)
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
        phys = esper.component_for_entity(ent, VehiclePhysics)
        if phys.vehicle_type == "oil_tanker":
            behavior = "tanker_transit"
        elif phys.vehicle_type == "frigate":
            behavior = "escort"
        elif phys.vehicle_type == "quadcopter":
            behavior = "quadcopter_intercept"
        else:
            behavior = "shahed_intercept"
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
