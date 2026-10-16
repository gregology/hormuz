"""Input commands wait for their tick and apply one per tick."""

from hormuz.commands import CommandBuffer


def command(sequence: int) -> dict:
    return {"sequence": sequence, "keys": 0}


def test_commands_apply_one_per_tick_in_the_order_sent():
    commands = CommandBuffer()
    for sequence in (1, 2, 3):
        commands.push(command(sequence))
    applied = [commands.take()["sequence"] for _ in range(3)]
    assert applied == [1, 2, 3]
    assert commands.last_applied == 3


def test_a_tick_without_a_new_command_keeps_the_last_one():
    commands = CommandBuffer()
    commands.push(command(1))
    commands.take()
    assert commands.take() is None
    assert commands.last_applied == 1


def test_a_burst_beyond_capacity_skips_the_oldest_commands():
    commands = CommandBuffer(capacity=2)
    for sequence in (1, 2, 3, 4):
        commands.push(command(sequence))
    assert commands.buffered == 2
    assert commands.take()["sequence"] == 3
