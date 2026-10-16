"""Cross-host physics contract (server side).

Replays the scenarios in shared/physics_fixtures.json through the server's
controls and physics and compares them tick by tick with the client's
reference implementation, which recorded them. Clients predict their own
vehicle with that reference, so any drift here shows in game as corrections.
Regenerate with:
UPDATE_PHYSICS_FIXTURES=1 pnpm --filter @hormuz/client test -- physics-contract
"""

import json
import math
from pathlib import Path

import pytest

from hormuz.components import Transform, VehiclePhysics
from hormuz.controls import vehicle_controls
from hormuz.generated.vehicles import TICK_RATE, VEHICLE_PHYSICS
from hormuz.systems.physics import _update_vehicle

FIXTURE_PATH = Path(__file__).resolve().parents[2] / "shared" / "physics_fixtures.json"
TOLERANCE = 1e-6
RECORD_EVERY = 5
FIELDS = ("x", "y", "heading", "speed", "drift", "angular_velocity")

try:
    with FIXTURE_PATH.open() as f:
        SCENARIOS = json.load(f)
except (OSError, json.JSONDecodeError) as e:
    raise RuntimeError(
        f"Physics fixtures unreadable at {FIXTURE_PATH} — regenerate with "
        "UPDATE_PHYSICS_FIXTURES=1 pnpm --filter @hormuz/client test -- physics-contract"
    ) from e


def _run_scenario(scenario: dict) -> list[list[float]]:
    """Mirror of runScenario in client/src/vehicles/physics-contract.test.ts."""
    vehicle_type = scenario["vehicleType"]
    start = scenario["start"]
    tf = Transform(x=start["x"], y=start["y"], heading=start["heading"])
    phys = VehiclePhysics(**VEHICLE_PHYSICS[vehicle_type])
    states = []
    tick = 0
    for phase in scenario["phases"]:
        throttle, rudder = vehicle_controls(
            vehicle_type,
            phase["keys"],
            phase["throttle"],
            near_jammer=lambda phase=phase: phase["nearJammer"],
        )
        for _ in range(phase["ticks"]):
            _update_vehicle(tf, phys, throttle, rudder, 1.0 / TICK_RATE)
            tick += 1
            if tick % RECORD_EVERY == 0:
                states.append([getattr(tf, field) for field in FIELDS])
    return states


def _difference(field: str, a: float, b: float) -> float:
    if field == "heading":
        # The hosts may write the same angle either side of the 0/2π seam.
        return abs(math.remainder(a - b, math.tau))
    return abs(a - b)


@pytest.mark.parametrize("scenario", SCENARIOS, ids=[s["name"] for s in SCENARIOS])
def test_physics_matches_the_client_reference(scenario: dict) -> None:
    actual = _run_scenario(scenario)
    expected = scenario["expected"]
    assert len(actual) == len(expected), "tick count mismatch"
    for row, (state, wanted) in enumerate(zip(actual, expected, strict=True)):
        tick = (row + 1) * RECORD_EVERY
        for field, value, target in zip(FIELDS, state, wanted, strict=True):
            difference = _difference(field, value, target)
            assert difference < TOLERANCE, f"tick {tick} {field}: {value} vs {target}"
