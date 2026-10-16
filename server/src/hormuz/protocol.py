"""MessagePack protocol — encode/decode messages between server and client."""

from typing import NamedTuple

import msgpack

# Server -> Client message types
MSG_FULL_SNAPSHOT = 1
MSG_SNAPSHOT_DELTA = 2
MSG_EVENTS = 3
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


# MessagePack header of a four-element array. An array is its header followed
# by its encoded elements, so a snapshot's shared elements can be encoded once.
_SNAPSHOT_HEADER = b"\x94"


class ControlledVehicle(NamedTuple):
    """What one client needs to predict the vehicle it drives."""

    entity_id: int
    # Sequence number of the newest input command applied (0 before the first).
    last_command: int
    # Commands received but still waiting for their tick.
    buffered_commands: int


class Snapshot:
    """A full snapshot, encoded once per tick and completed for each client.

    Every client gets the same entity list. Only the last element, the
    client's own vehicle, differs, so it is appended to the shared bytes
    rather than encoding the whole snapshot again per client.
    """

    def __init__(self, tick: int, entities: list[tuple]) -> None:
        self._shared = (
            _SNAPSHOT_HEADER
            + msgpack.packb(MSG_FULL_SNAPSHOT)
            + msgpack.packb(tick)
            + msgpack.packb([_pack_entity(entry) for entry in entities])
        )

    def for_client(self, controlled: ControlledVehicle | None) -> bytes:
        return self._shared + msgpack.packb(list(controlled) if controlled else None)


def _pack_entity(entry: tuple) -> list:
    (
        eid,
        vtype,
        faction,
        x,
        y,
        heading,
        speed,
        drift,
        angular_velocity,
        hp,
        flood_level,
        list_angle,
        battery_pct,
    ) = entry
    # Motion goes out at full precision. MessagePack spends 8 bytes on every
    # float regardless, so rounding saved nothing; its 0.1-unit position steps
    # showed as jitter on small drones seen up close, and clients predicting
    # their own vehicle replay its physics from exactly the server's state.
    return [
        eid,
        VEHICLE_TYPE_INDEX.get(vtype, 0),
        FACTION_INDEX.get(faction, 0),
        x,
        y,
        heading,
        speed,
        drift,
        hp,
        angular_velocity,
        round(flood_level, 2),
        round(list_angle, 3),
        battery_pct,
    ]


def encode_assign_vehicle(entity_id: int, vehicle_type: str) -> bytes:
    return msgpack.packb([MSG_ASSIGN_VEHICLE, entity_id, vehicle_type])


def encode_war_cost(
    total_usd: int,
    tankers_delivered: int,
    tankers_sunk: int,
    frigates_sunk: int,
    shaheds_intercepted: int,
    quadcopters_intercepted: int,
    speedboats_sunk: int,
    players_online: int,
) -> bytes:
    return msgpack.packb(
        [
            MSG_WAR_COST,
            total_usd,
            tankers_delivered,
            tankers_sunk,
            frigates_sunk,
            shaheds_intercepted,
            quadcopters_intercepted,
            speedboats_sunk,
            players_online,
        ]
    )


# Fields each event type carries after its type, x and y.
EVENT_EXTRA_FIELDS: dict[str, tuple[str, ...]] = {"projectile": ("target_x", "target_y")}


def encode_events(tick: int, events: list[dict]) -> bytes:
    """Encode the events of one tick; clients play them when playback reaches it."""
    packed = [
        [
            event["type"],
            event["x"],
            event["y"],
            *(event[field] for field in EVENT_EXTRA_FIELDS.get(event["type"], ())),
        ]
        for event in events
    ]
    return msgpack.packb([MSG_EVENTS, tick, packed])


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
            "sequence": msg[7] if len(msg) > 7 else 0,
        }
    if msg_type == MSG_HEARTBEAT:
        return {"type": MSG_HEARTBEAT}
    if msg_type == MSG_RESPAWN_CHOICE:
        return {"type": MSG_RESPAWN_CHOICE, "vehicle_type": msg[1]}
    return {"type": msg_type}
