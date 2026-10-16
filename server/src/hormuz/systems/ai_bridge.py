"""Bridge to the shared Lua AI (shared/ai/) via lupa.

The Lua VM owns all behavior logic — the same scripts that run in the
playground's fengari host (client/src/ai/lua-host.ts). Python owns esper
state: bot state persists in BotControl components, so the VM can be rebuilt
(hot reload on script changes) without losing targets/waypoints/stamina.
Danger scents live inside the VM and reset on reload (they decay within
60 seconds anyway, so the loss is minor).

Both hosts implement the same contract:
  - "ai.gamedata" module returning static map/vehicle data
  - a global is_land(x, y) terrain query
  - globals ai_compute(world) -> (controls, errors), ai_add_scent,
    ai_waypoint_follow, ai_get_config, ai_set_config
"""

import logging
import os
from pathlib import Path

from lupa import LuaError, LuaRuntime

from hormuz.generated.map_data import (
    EXCLUSION_ZONES,
    GULF_DESTINATION,
    LANE_ALT_INBOUND,
    LANE_ALT_OUTBOUND,
    OMAN_DESTINATION,
    SPEEDBOAT_SPAWNS,
    STRAIT_CENTER,
)
from hormuz.generated.terrain_grid import is_land
from hormuz.generated.vehicles import DETECTION_RANGE, JAM_RADIUS, VEHICLE_PHYSICS

log = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[4]
_AI_DIR = _REPO_ROOT / "shared" / "ai"


def _build_game_data() -> dict:
    detection_ranges = {
        observer: {target: r for target, r in targets.items() if r is not None}
        for observer, targets in DETECTION_RANGE.items()
        if targets
    }
    # table_from(recursive=True) breaks on objects referenced twice in the
    # structure (cycle guard), so lanes and routes each get their own copies.
    lanes_outbound = [[x, y] for x, y in LANE_ALT_OUTBOUND]
    lanes_inbound = [[x, y] for x, y in LANE_ALT_INBOUND]
    route_outbound = [[x, y] for x, y in LANE_ALT_OUTBOUND]
    route_inbound = [[x, y] for x, y in LANE_ALT_INBOUND]
    return {
        "lanes": {"outbound": lanes_outbound, "inbound": lanes_inbound},
        "routes": {
            "oman": {"route": route_outbound, "exit": list(OMAN_DESTINATION["position"])},
            "gulf": {"route": route_inbound, "exit": list(GULF_DESTINATION["position"])},
        },
        "strait_center": list(STRAIT_CENTER),
        "exclusion_zones": [
            {
                "name": z["name"],
                "polygon": [[x, y] for x, y in z["polygon"]],
                "behaviors": list(z["behaviors"]),
            }
            for z in EXCLUSION_ZONES
        ],
        "speedboat_homes": [[s["position"][0], s["position"][1]] for s in SPEEDBOAT_SPAWNS],
        "detection_ranges": detection_ranges,
        "jam_radius": JAM_RADIUS,
        "max_speeds": {vehicle: p["max_speed"] for vehicle, p in VEHICLE_PHYSICS.items()},
    }


class AIBridge:
    """Owns the LuaRuntime. Rebuild it to hot-reload scripts from disk."""

    def __init__(self) -> None:
        self._time = 0.0
        self._lua: LuaRuntime | None = None
        self._file_mtimes: dict[Path, float] = {}
        self._build_vm()

    def _build_vm(self) -> None:
        lua = LuaRuntime(unpack_returned_tuples=True)
        globals_table = lua.globals()
        globals_table["__ai_shared_root"] = str(_REPO_ROOT / "shared")
        globals_table["__py_gamedata"] = lua.table_from(_build_game_data(), recursive=True)
        globals_table["is_land"] = is_land
        # Lua 5.5's preload searcher rejects non-Lua callables, so the
        # gamedata loader must be wrapped in a Lua function. Remove the
        # libraries the browser host never opens (sandbox parity).
        lua.execute("""
            package.path = package.path .. ";" .. __ai_shared_root .. "/?.lua"
            __ai_shared_root = nil
            io = nil
            os = nil
            debug = nil
            coroutine = nil
            utf8 = nil
            package.preload["ai.gamedata"] = function() return __py_gamedata end
            local main = require("ai.main")
            function ai_compute(world) return main.compute_controls(world) end
            function ai_add_scent(x, y) main.add_scent(x, y) end
            function ai_waypoint_follow(x, y, heading, idx, dest)
                return main.waypoint_follow(x, y, heading, idx, dest)
            end
            function ai_get_config() return main.get_config_flat() end
            function ai_set_config(path, value) return main.set_config(path, value) end
        """)
        self._lua = lua
        self._file_mtimes = self._scan_mtimes()

    @property
    def _rt(self) -> LuaRuntime:
        if self._lua is None:
            raise RuntimeError("AI VM not initialized")
        return self._lua

    @staticmethod
    def _scan_mtimes() -> dict[Path, float]:
        if not _AI_DIR.is_dir():
            return {}
        return {p: os.path.getmtime(p) for p in _AI_DIR.rglob("*.lua")}

    def maybe_reload(self) -> bool:
        """Rebuild the VM if any script changed on disk. Returns True if reloaded."""
        mtimes = self._scan_mtimes()
        if mtimes != self._file_mtimes:
            log.info("AI scripts changed on disk — rebuilding Lua VM")
            self._build_vm()
            return True
        return False

    def compute(self, entities: list[dict], dt: float) -> tuple[list[dict], list[str]]:
        """Run one AI tick over the given entity views (must be sorted by id)."""
        self._time += dt
        world = self._rt.table_from(
            {"time": self._time, "dt": dt, "entities": entities}, recursive=True
        )
        try:
            controls, errors = self._rt.globals()["ai_compute"](world)
        except LuaError as e:
            log.error("ai_compute failed: %s", e)
            return [], [str(e)]
        try:
            result = [
                {
                    "id": int(c["id"]),
                    "throttle": float(c["throttle"]),
                    "rudder": float(c["rudder"]),
                    "target": int(c["target"]),
                    "waypoint_index": int(c["waypoint_index"]),
                    "stamina": float(c["stamina"]),
                    "group": int(c["group"]),
                }
                for c in controls.values()
            ]
            return result, [str(e) for e in errors.values()]
        except (TypeError, KeyError, ValueError) as e:
            log.error("malformed AI controls: %s", e)
            return [], [str(e)]

    def emit_scent(self, x: float, y: float) -> None:
        """Record a danger event (hull breach, sinking) at this location."""
        self._rt.globals()["ai_add_scent"](x, y)

    def waypoint_follow(
        self, x: float, y: float, heading: float, waypoint_index: int, destination: str
    ) -> tuple[float, int]:
        """Waypoint route following for the player tanker autopilot."""
        rudder, new_index = self._rt.globals()["ai_waypoint_follow"](
            x, y, heading, waypoint_index, destination
        )
        try:
            return float(rudder), int(new_index)
        except (TypeError, ValueError) as e:
            raise LuaError(f"malformed waypoint_follow result: {e}") from e


_bridge: AIBridge | None = None


def get_bridge() -> AIBridge:
    global _bridge
    if _bridge is None:
        _bridge = AIBridge()
    return _bridge


def reset_bridge() -> None:
    """Drop the singleton (tests: clean scents and config between worlds)."""
    global _bridge
    _bridge = None
