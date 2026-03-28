import asyncio
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

app = FastAPI(title="Hormuz", version="0.0.1")

TICK_RATE = 20
TICK_INTERVAL = 1.0 / TICK_RATE

# Connected clients
connections: set[WebSocket] = set()

# Game state placeholder
game_state = {
    "tick": 0,
    "war_cost_usd": 0,
    "entities": 0,
    "uptime_seconds": 0.0,
}

start_time = time.monotonic()


async def game_loop() -> None:
    """Main server game loop running at TICK_RATE Hz."""
    while True:
        t0 = time.monotonic()

        # Update game state
        game_state["tick"] += 1
        game_state["uptime_seconds"] = round(time.monotonic() - start_time, 1)

        # TODO: ECS world.tick(dt) goes here
        # TODO: broadcast snapshot to connected clients

        elapsed = time.monotonic() - t0
        await asyncio.sleep(max(0, TICK_INTERVAL - elapsed))


@app.on_event("startup")
async def startup() -> None:
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
            "entities": game_state["entities"],
            "players": len(connections),
            "uptime_seconds": game_state["uptime_seconds"],
        }
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    connections.add(websocket)
    try:
        while True:
            _data = await websocket.receive_bytes()
            # TODO: process client input
    except WebSocketDisconnect:
        connections.discard(websocket)
