"""FastAPI application — thin wiring layer over GameServer.

Handles HTTP endpoints, WebSocket connections, and the async game loop.
All game logic lives in game_server.py and the ECS systems.
"""

import asyncio
import logging
import time
from pathlib import Path

import esper
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from hormuz.components import Transform, VehiclePhysics
from hormuz.game_server import TICK_INTERVAL, TICK_RATE, GameServer
from hormuz.protocol import (
    MSG_INPUT,
    decode_client_message,
    encode_assign_vehicle,
    encode_event,
    encode_full_snapshot,
    encode_war_cost,
)
from hormuz.systems.combat import CombatProcessor
from hormuz.systems.spawn import SpawnProcessor

logger = logging.getLogger("hormuz")

app = FastAPI(title="Hormuz", version="0.0.1")

# --- Server instance ---
server = GameServer()

# --- WebSocket connection tracking ---
connections: dict[int, WebSocket] = {}


# --- Networking helpers ---


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
        server.release_vehicle(conn_id)


# --- Game loop ---


async def game_loop() -> None:
    """Main server game loop running at TICK_RATE Hz."""
    while True:
        t0 = time.monotonic()

        server.tick()

        # Clean up players whose vehicles were killed — auto-assign a random new one
        for conn_id in server.get_dead_player_entities():
            if conn_id in connections:
                new_ent = server.assign_vehicle_to_player(conn_id, teleport=True)
                if new_ent is not None:
                    new_phys = esper.component_for_entity(new_ent, VehiclePhysics)
                    try:
                        await connections[conn_id].send_bytes(
                            encode_assign_vehicle(new_ent, new_phys.vehicle_type)
                        )
                    except Exception:
                        pass

        # Broadcast snapshot to all clients
        snapshot = server.build_snapshot()
        await broadcast(snapshot)

        # Broadcast events (explosions, deliveries, projectiles)
        combat_proc = esper.get_processor(CombatProcessor)
        spawn_proc = esper.get_processor(SpawnProcessor)
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
        gs = server.game_state
        if gs["tick"] % TICK_RATE == 0:
            await broadcast(
                encode_war_cost(
                    gs["war_cost_usd"],
                    gs["tankers_delivered"],
                    gs["tankers_sunk"],
                    gs["frigates_sunk"],
                    gs["shaheds_intercepted"],
                    gs["quadcopters_intercepted"],
                    len(server.player_entities),
                )
            )

        elapsed = time.monotonic() - t0
        await asyncio.sleep(max(0, TICK_INTERVAL - elapsed))


# --- FastAPI endpoints ---


@app.on_event("startup")
async def startup() -> None:
    server.setup_world()
    asyncio.create_task(game_loop())


@app.get("/api/status")
async def status() -> JSONResponse:
    gs = server.game_state
    return JSONResponse(
        {
            "game": "hormuz",
            "version": "0.0.1",
            "tick_rate": TICK_RATE,
            "tick": gs["tick"],
            "war_cost_usd": gs["war_cost_usd"],
            "tankers_delivered": gs["tankers_delivered"],
            "tankers_sunk": gs["tankers_sunk"],
            "frigates_sunk": gs["frigates_sunk"],
            "shaheds_intercepted": gs["shaheds_intercepted"],
            "entities": len(list(esper.get_component(Transform))),
            "players": len(server.player_entities),
            "uptime_seconds": gs["uptime_seconds"],
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
    await websocket.accept()

    conn_id = server.next_conn_id()
    connections[conn_id] = websocket

    # Assign a vehicle to this player
    assigned = server.assign_vehicle_to_player(conn_id)
    if assigned is not None:
        phys = esper.component_for_entity(assigned, VehiclePhysics)
        await websocket.send_bytes(encode_assign_vehicle(assigned, phys.vehicle_type))

    # Send full snapshot
    await websocket.send_bytes(server.build_snapshot())

    # Send current stats
    gs = server.game_state
    await websocket.send_bytes(
        encode_war_cost(
            gs["war_cost_usd"],
            gs["tankers_delivered"],
            gs["tankers_sunk"],
            gs["frigates_sunk"],
            gs["shaheds_intercepted"],
            gs["quadcopters_intercepted"],
            len(server.player_entities),
        )
    )

    try:
        while True:
            data = await websocket.receive_bytes()
            msg = decode_client_message(data)
            if msg["type"] == MSG_INPUT:
                server.apply_input(conn_id, msg)
    except WebSocketDisconnect:
        connections.pop(conn_id, None)
        server.release_vehicle(conn_id)


# --- Static file serving (production: serve built client) ---

CLIENT_DIST = Path(__file__).parent.parent.parent.parent / "client" / "dist"
if CLIENT_DIST.exists():
    app.mount("/", StaticFiles(directory=str(CLIENT_DIST), html=True), name="static")
