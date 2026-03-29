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

# Vehicle type indices (compact encoding for snapshots)
VEHICLE_TYPE_INDEX = {"oil_tanker": 0, "shahed": 1, "speedboat": 2, "frigate": 3}
VEHICLE_TYPE_NAME = {v: k for k, v in VEHICLE_TYPE_INDEX.items()}

# Faction indices
FACTION_INDEX = {"civilian": 0, "iran": 1, "us": 2}
FACTION_NAME = {v: k for k, v in FACTION_INDEX.items()}


def encode_full_snapshot(
    tick: int,
    entities: list[tuple[int, str, str, float, float, float, float, float, int]],
) -> bytes:
    """Encode full snapshot as msgpack array."""
    packed = []
    for eid, vtype, faction, x, y, heading, speed, drift, hp in entities:
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
            ]
        )
    return msgpack.packb([MSG_FULL_SNAPSHOT, tick, packed])


def encode_assign_vehicle(entity_id: int, vehicle_type: str) -> bytes:
    return msgpack.packb([MSG_ASSIGN_VEHICLE, entity_id, vehicle_type])


def encode_war_cost(total_usd: int, tankers_delivered: int, tankers_sunk: int) -> bytes:
    return msgpack.packb([MSG_WAR_COST, total_usd, tankers_delivered, tankers_sunk])


def encode_event(event_type: str, x: float, y: float) -> bytes:
    return msgpack.packb([MSG_EVENT, event_type, round(x, 1), round(y, 1)])


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
        }
    if msg_type == MSG_HEARTBEAT:
        return {"type": MSG_HEARTBEAT}
    return {"type": msg_type}
