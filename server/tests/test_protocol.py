"""Snapshot encoding."""

import msgpack

from hormuz.protocol import MSG_FULL_SNAPSHOT, encode_full_snapshot


def test_snapshot_keeps_positions_and_headings_exact():
    entity = (
        7,
        "quadcopter",
        "iran",
        85123.4567,
        40210.0891,
        1.2345678,
        30.0,
        0.0,
        0.0,
        13,
        0.0,
        0.0,
        80.0,
    )
    message = msgpack.unpackb(encode_full_snapshot(42, [entity]))
    assert message[:2] == [MSG_FULL_SNAPSHOT, 42]
    _, _, _, x, y, heading, *_ = message[2][0]
    assert (x, y, heading) == (85123.4567, 40210.0891, 1.2345678)
