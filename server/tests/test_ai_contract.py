"""Cross-host AI contract test (server side).

Runs the committed fixture scenarios (shared/ai/contract_fixtures.json)
through the lupa bridge and compares tick-by-tick outputs against the
expected values recorded by the client fengari host. The fixture is
regenerated with: UPDATE_AI_FIXTURES=1 pnpm --filter @hormuz/client test -- contract

This pins behavioral parity between the two Lua runtimes: any drift in
behavior, bindings, or float handling fails here.
"""

import json
from pathlib import Path

import pytest

from hormuz.systems.ai_bridge import get_bridge, reset_bridge

FIXTURE_PATH = Path(__file__).resolve().parents[2] / "shared" / "ai" / "contract_fixtures.json"
TOLERANCE = 1e-9

try:
    with FIXTURE_PATH.open() as f:
        SCENARIOS = json.load(f)
except (OSError, json.JSONDecodeError) as e:
    raise RuntimeError(
        f"AI fixtures unreadable at {FIXTURE_PATH} — regenerate with "
        "UPDATE_AI_FIXTURES=1 pnpm --filter @hormuz/client test -- contract"
    ) from e


def _run_scenario(scn: dict) -> list[list[dict]]:
    """Mirror of runScenario in client/src/ai/contract.test.ts."""
    reset_bridge()
    bridge = get_bridge()

    bot_states = {e["id"]: dict(e["bot"]) for e in scn["entities"] if e.get("bot")}
    ticks: list[list[dict]] = []
    dt = scn["dt"]
    for tick in range(scn["ticks"]):
        for scent in scn["scents"]:
            if scent["at_tick"] == tick:
                bridge.emit_scent(scent["x"], scent["y"])
        entities = []
        for e in scn["entities"]:
            view = {k: v for k, v in e.items() if k != "bot"}
            if e.get("bot"):
                view["bot"] = bot_states[e["id"]]
            entities.append(view)
        controls, errors = bridge.compute(entities, dt)
        assert not errors, f"scenario {scn['name']!r} tick {tick}: {errors}"
        for c in controls:
            prev = bot_states.get(c["id"])
            if prev is not None:
                prev.update(
                    throttle=c["throttle"],
                    rudder=c["rudder"],
                    target=c["target"],
                    waypoint_index=c["waypoint_index"],
                    stamina=c["stamina"],
                )
        ticks.append(controls)
    return ticks


@pytest.mark.parametrize("scn", SCENARIOS, ids=[s["name"] for s in SCENARIOS])
def test_contract_scenario(scn: dict) -> None:
    actual = _run_scenario(scn)
    expected = scn["expected"]
    assert len(actual) == len(expected), "tick count mismatch"
    for t, (actual_tick, expected_tick) in enumerate(zip(actual, expected, strict=True)):
        assert len(actual_tick) == len(expected_tick), f"tick {t}: control count mismatch"
        for a, e in zip(actual_tick, expected_tick, strict=True):
            where = f"tick {t} entity {e['id']}"
            assert a["id"] == e["id"], where
            assert a["target"] == e["target"], where
            assert a["waypoint_index"] == e["waypoint_index"], where
            for key in ("throttle", "rudder", "stamina"):
                assert abs(a[key] - e[key]) <= TOLERANCE, f"{where} {key}: {a[key]} vs {e[key]}"
