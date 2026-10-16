"""Game loop tick scheduling."""

import pytest

from hormuz.tick_schedule import TickSchedule

INTERVAL = 0.05


def run_ticks(schedule: TickSchedule, start: float, wake_lateness: list[float], work: float):
    """Simulate ticks that each wake up late and take `work` seconds; return tick start times."""
    now = start
    starts = []
    for lateness in wake_lateness:
        now += lateness
        starts.append(now)
        now += work
        now += schedule.wait(now)
    return starts


def test_late_wake_ups_do_not_slow_the_tick_rate():
    schedule = TickSchedule(INTERVAL, now=0.0, max_lag=0.25)
    starts = run_ticks(schedule, 0.0, wake_lateness=[0.03, 0.0, 0.02, 0.04] * 50, work=0.01)
    ticks = len(starts) - 1
    # 200 ticks at 20 Hz is ~10 s; sleeping "the rest of the tick" took 14 s.
    assert starts[-1] - starts[0] == pytest.approx(ticks * INTERVAL, abs=INTERVAL)


def test_a_slow_tick_is_made_up_by_shorter_waits():
    schedule = TickSchedule(INTERVAL, now=0.0, max_lag=0.25)
    assert schedule.wait(0.12) == 0.0  # tick took 120 ms: run the next one at once
    assert schedule.wait(0.12) == 0.0  # still behind the 0.10 deadline
    assert schedule.wait(0.13) == pytest.approx(0.02)  # back on the 0.15 grid


def test_after_a_long_pause_ticks_resume_at_the_normal_rate():
    schedule = TickSchedule(INTERVAL, now=0.0, max_lag=0.25)
    assert schedule.wait(5.0) == 0.0
    assert schedule.wait(5.0) == pytest.approx(INTERVAL)
