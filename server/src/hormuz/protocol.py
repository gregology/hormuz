"""MessagePack protocol — encode/decode messages between server and client."""

import msgpack

# Server -> Client message types
MSG_FULL_SNAPSHOT = 1
MSG_SNAPSHOT_DELTA = 2
MSG_EVENT = 3
MSG_ASSIGN_VEHICLE = 4
MSG_WAR_COST = 5

# Client -> Server message types
MSG_INPUT = 10
MSG_HEARTBEAT = 11
MSG_RESPAWN_CHOICE = 12

# Vehicle type indices (compact encoding for snapshots)
VEHICLE_TYPE_INDEX = {"oil_tanker": 0, "shahed": 1, "speedboat": 2, "frigate": 3, "quadcopter": 4}
VEHICLE_TYPE_NAME = {v: k for k, v in VEHICLE_TYPE_INDEX.items()}

# Faction indices
FACTION_INDEX = {"civilian": 0, "iran": 1, "us": 2}
FACTION_NAME = {v: k for k, v in FACTION_INDEX.items()}


def encode_full_snapshot(
    tick: int,
    entities: list[tuple],
) -> bytes:
    """Encode full snapshot as msgpack array."""
    packed = []
    for entry in entities:
        (
            eid, vtype, faction, x, y, heading, speed, drift,
            angular_velocity, hp, flood_level, list_angle, battery_pct,
        ) = entry
        packed.append(
            [
                eid,
                VEHICLE_TYPE_INDEX.get(vtype, 0),
                FACTION_INDEX.get(faction, 0),
                round(x, 1),
                round(y, 1),
                round(heading, 3),
                round(speed, 2),
                round(drift, 2),
                hp,
                round(angular_velocity, 3),
                round(flood_level, 2),
                round(list_angle, 3),
                battery_pct,
            ]
        )
    return msgpack.packb([MSG_FULL_SNAPSHOT, tick, packed])


def encode_assign_vehicle(entity_id: int, vehicle_type: str) -> bytes:
    return msgpack.packb([MSG_ASSIGN_VEHICLE, entity_id, vehicle_type])


def encode_war_cost(
    total_usd: int,
    tankers_delivered: int,
    tankers_sunk: int,
    frigates_sunk: int,
    shaheds_intercepted: int,
    quadcopters_intercepted: int,
    players_online: int,
) -> bytes:
    return msgpack.packb([
        MSG_WAR_COST,
        total_usd,
        tankers_delivered,
        tankers_sunk,
        frigates_sunk,
        shaheds_intercepted,
        quadcopters_intercepted,
        players_online,
    ])


def encode_event(event_type: str, x: float, y: float, *extra: float) -> bytes:
    data: list = [MSG_EVENT, event_type, round(x, 1), round(y, 1)]
    for v in extra:
        data.append(round(v, 1))
    return msgpack.packb(data)


def decode_client_message(data: bytes) -> dict:
    """Decode a client message. Returns dict with 'type' key."""
    msg = msgpack.unpackb(data)
    msg_type = msg[0]
    if msg_type == MSG_INPUT:
        return {
            "type": MSG_INPUT,
            "keys": msg[1],
            "mouse_x": msg[2] if len(msg) > 2 else 0,
            "mouse_y": msg[3] if len(msg) > 3 else 0,
            "action": msg[4] if len(msg) > 4 else 0,
            "throttle_float": msg[5] if len(msg) > 5 else 0.0,
            "autopilot": bool(msg[6]) if len(msg) > 6 else False,
        }
    if msg_type == MSG_HEARTBEAT:
        return {"type": MSG_HEARTBEAT}
    if msg_type == MSG_RESPAWN_CHOICE:
        return {"type": MSG_RESPAWN_CHOICE, "vehicle_type": msg[1]}
    return {"type": msg_type}
