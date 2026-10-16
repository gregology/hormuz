"""Per-client outbound queue, so one slow connection never holds up the game.

The game loop hands messages over without waiting; each client's own task
writes them to its socket. Snapshots supersede each other, so a client that
falls behind skips to the newest one instead of working through a backlog.
Other messages (vehicle assignments, events, stats) are kept, in order. A
client whose socket makes no progress for `stall_timeout` is dropped at once
via `on_stalled`; closing its socket can take much longer, because a peer
that has stopped reading never answers the close handshake.
"""

import asyncio
import contextlib
import logging
from collections import deque
from collections.abc import Callable
from typing import Protocol

STALL_TIMEOUT = 10.0

log = logging.getLogger(__name__)


class BinarySocket(Protocol):
    async def send_bytes(self, data: bytes) -> None: ...

    async def close(self, code: int = 1000) -> None: ...


class ClientSender:
    def __init__(
        self,
        socket: BinarySocket,
        on_stalled: Callable[[], None],
        stall_timeout: float = STALL_TIMEOUT,
    ) -> None:
        self._socket = socket
        self._on_stalled = on_stalled
        self._stall_timeout = stall_timeout
        self._queue: deque[tuple[bool, bytes]] = deque()  # (is_snapshot, message)
        self._ready = asyncio.Event()
        self._task = asyncio.create_task(self._run())

    def send(self, data: bytes) -> None:
        """Queue a message for delivery after everything queued before it."""
        self._queue.append((False, data))
        self._ready.set()

    def send_snapshot(self, data: bytes) -> None:
        """Queue a snapshot, replacing any older snapshot not yet sent."""
        self._queue = deque(item for item in self._queue if not item[0])
        self._queue.append((True, data))
        self._ready.set()

    def stop(self) -> None:
        self._task.cancel()

    async def _run(self) -> None:
        try:
            while True:
                await self._ready.wait()
                self._ready.clear()
                while self._queue:
                    _, data = self._queue.popleft()
                    async with asyncio.timeout(self._stall_timeout):
                        await self._socket.send_bytes(data)
        except TimeoutError:
            log.warning("Dropping a client that made no progress for %.0f s", self._stall_timeout)
            self._on_stalled()
            with contextlib.suppress(Exception):
                await self._socket.close()
        except Exception:
            # The socket is already gone; its receive loop cleans up.
            pass
