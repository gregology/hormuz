"""Per-client outbound queue."""

import asyncio

from hormuz.client_sender import ClientSender


class FakeSocket:
    """A client connection whose sends complete only while `flowing` is set."""

    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.closed = False
        self.flowing = asyncio.Event()

    async def send_bytes(self, data: bytes) -> None:
        await self.flowing.wait()
        self.sent.append(data)

    async def close(self, code: int = 1000) -> None:
        self.closed = True


async def settle() -> None:
    for _ in range(10):
        await asyncio.sleep(0)


async def test_a_client_that_falls_behind_gets_the_newest_snapshot_not_a_backlog():
    socket = FakeSocket()
    sender = ClientSender(socket, on_stalled=lambda: None)
    for tick in range(1, 6):
        sender.send_snapshot(f"snapshot {tick}".encode())
        await settle()
    socket.flowing.set()
    await settle()
    assert socket.sent == [b"snapshot 1", b"snapshot 5"]  # 1 was already on the wire
    sender.stop()


async def test_other_messages_reach_a_slow_client_in_order():
    socket = FakeSocket()
    sender = ClientSender(socket, on_stalled=lambda: None)
    sender.send_snapshot(b"snapshot 1")
    await settle()
    sender.send(b"assign")
    sender.send_snapshot(b"snapshot 2")
    sender.send(b"explosion")
    sender.send_snapshot(b"snapshot 3")
    socket.flowing.set()
    await settle()
    assert socket.sent == [b"snapshot 1", b"assign", b"explosion", b"snapshot 3"]
    sender.stop()


async def test_a_client_that_stops_reading_is_dropped_and_closed():
    socket = FakeSocket()
    dropped = []
    sender = ClientSender(socket, on_stalled=lambda: dropped.append(True), stall_timeout=0.05)
    sender.send_snapshot(b"snapshot 1")
    await asyncio.sleep(0.1)
    assert dropped == [True]
    assert socket.closed
    sender.stop()
