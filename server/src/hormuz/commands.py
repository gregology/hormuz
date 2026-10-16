"""Per-client queue of input commands, applied one per tick.

A client sends one numbered command per tick and predicts its own vehicle by
running each command through the same physics the server will. That only
works if the server applies every command exactly once, in the order sent, one
per tick, rather than whatever input happened to arrive last. Commands that
arrive early wait here; if none has arrived by a tick, the vehicle keeps its
last input.
"""

from collections import deque

# Most commands kept waiting. A burst after a stalled connection beyond this
# skips the oldest, so it can't leave the player's input permanently delayed.
MAX_BUFFERED_COMMANDS = 4


class CommandBuffer:
    def __init__(self, capacity: int = MAX_BUFFERED_COMMANDS) -> None:
        self._waiting: deque[dict] = deque()
        self._capacity = capacity
        self.last_applied = 0
        """Sequence number of the newest command taken (0 before the first)."""

    @property
    def buffered(self) -> int:
        """Commands received and still waiting for their tick."""
        return len(self._waiting)

    def push(self, command: dict) -> None:
        self._waiting.append(command)
        while len(self._waiting) > self._capacity:
            self._waiting.popleft()

    def take(self) -> dict | None:
        """The command to apply this tick, or None to keep the last one."""
        if not self._waiting:
            return None
        command = self._waiting.popleft()
        self.last_applied = command["sequence"]
        return command
