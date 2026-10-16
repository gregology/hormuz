"""Message encoding between server and clients."""

import msgpack

from hormuz.protocol import (
    MSG_EVENTS,
    MSG_FULL_SNAPSHOT,
    MSG_INPUT,
    ControlledVehicle,
    Snapshot,
    decode_client_message,
    encode_events,
)

QUADCOPTER = (
    7,
    "quadcopter",
    "iran",
    85123.4567,
    40210.0891,
    1.2345678,
    29.87654321,
    0.123456789,
    0.0123456789,
    13,
    0.0,
    0.0,
    80.0,
)


def test_snapshot_keeps_motion_exact():
    message = msgpack.unpackb(Snapshot(42, [QUADCOPTER]).for_client(None))
    assert message[:2] == [MSG_FULL_SNAPSHOT, 42]
    _, _, _, x, y, heading, speed, drift, _, angular_velocity, *_ = message[2][0]
    assert (x, y, heading, speed, drift, angular_velocity) == (
        85123.4567,
        40210.0891,
        1.2345678,
        29.87654321,
        0.123456789,
        0.0123456789,
    )


def test_each_client_learns_which_vehicle_it_drives_and_how_many_commands_were_applied():
    snapshot = Snapshot(42, [QUADCOPTER])
    driver = msgpack.unpackb(snapshot.for_client(ControlledVehicle(7, 15, 2)))
    spectator = msgpack.unpackb(snapshot.for_client(None))
    assert driver[3] == [7, 15, 2]
    assert spectator[3] is None
    assert driver[:3] == spectator[:3]


def test_events_carry_their_tick_and_type_specific_fields():
    events = [
        {"type": "explosion", "x": 100.5, "y": 200.25},
        {"type": "projectile", "x": 1.0, "y": 2.0, "target_x": 3.0, "target_y": 4.0},
    ]
    assert msgpack.unpackb(encode_events(42, events)) == [
        MSG_EVENTS,
        42,
        [["explosion", 100.5, 200.25], ["projectile", 1.0, 2.0, 3.0, 4.0]],
    ]


def test_input_commands_carry_their_sequence_number():
    command = decode_client_message(msgpack.packb([MSG_INPUT, 0x05, 0, 0, 0, 0.5, 0, 31]))
    assert command["keys"] == 0x05
    assert command["throttle_float"] == 0.5
    assert command["sequence"] == 31
