"""Fixed-rate tick deadlines for the game loop.

Sleeping for "whatever is left of this tick" never makes up a late wake-up,
so every delay (a busy event loop, a slow tick) permanently slowed the game.
Deadlines sit on a fixed grid instead: a late tick shortens the next wait.
"""


class TickSchedule:
    def __init__(self, interval: float, now: float, max_lag: float) -> None:
        """`max_lag`: how far behind ticks may run back to back to catch up (seconds)."""
        self._interval = interval
        self._max_lag = max_lag
        self._deadline = now

    def wait(self, now: float) -> float:
        """Seconds to sleep before the next tick. Call once after each tick."""
        self._deadline += self._interval
        # After a long pause, start a new grid rather than racing through
        # every missed tick.
        if now - self._deadline > self._max_lag:
            self._deadline = now
        return max(0.0, self._deadline - now)
