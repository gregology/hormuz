#!/usr/bin/env python3
"""Generate Python and TypeScript definitions from shared YAML source-of-truth files."""

import json
from pathlib import Path

import yaml

SHARED_DIR = Path(__file__).parent.parent
SERVER_OUT = SHARED_DIR.parent / "server" / "src" / "hormuz" / "generated"
CLIENT_OUT = SHARED_DIR.parent / "client" / "src" / "generated"

# Physics fields that go into the generated VEHICLE_PHYSICS dicts.
# Order matters — this is the field order in the output.
PHYSICS_FIELDS = [
    "mass",
    "engine_power",
    "max_speed",
    "turn_rate",
    "drift_factor",
    "lateral_drag",
    "min_turn_fraction",
    "cruise_speed",
    "airborne",
    "size",
    "angular_drag",
    "propeller_offset",
    "rudder_max_angle",
    "moment_of_inertia",
]


def load_yaml(name: str) -> dict:
    with open(SHARED_DIR / name) as f:
        return yaml.safe_load(f)


def compute_derived_physics(phys: dict) -> dict:
    """Compute drag_coefficient and rudder_flow_coefficient from YAML fields."""
    ep = phys["engine_power"]
    ms = phys["max_speed"]
    ms_sq = ms * ms
    drag_coefficient = ep / ms_sq if ms_sq > 0 else 1.0
    rudder_flow_factor = phys.get("rudder_flow_factor", 0)
    rudder_flow_coefficient = rudder_flow_factor * ep / ms_sq if ms_sq > 0 else 0.0
    return {
        "drag_coefficient": drag_coefficient,
        "rudder_flow_coefficient": rudder_flow_coefficient,
    }


def fmt_float(v: float) -> str:
    """Format a float, dropping trailing zeros but keeping at least one decimal."""
    if v == int(v):
        return f"{int(v)}.0"
    # Use enough precision to avoid rounding issues
    s = f"{v:.10f}".rstrip("0")
    if s.endswith("."):
        s += "0"
    return s


# ---------------------------------------------------------------------------
# Python generation
# ---------------------------------------------------------------------------


def generate_python_vehicles(vehicles: dict, combat: dict, world: dict) -> str:
    lines = [
        '"""Auto-generated from shared/vehicles.yaml — do not edit."""',
        "",
        "from dataclasses import dataclass",
        "from typing import Any",
        "",
        "",
        "@dataclass(frozen=True)",
        "class VehicleDefinition:",
        "    name: str",
        "    faction: str",
        "    based_on: str",
        "    role: str",
        "    cost_usd: int",
        "    components: dict[str, Any]",
        "    ai_behavior: str",
        "    sprite: str",
        "",
        "",
        "VEHICLES: dict[str, VehicleDefinition] = {",
    ]
    for key, v in vehicles.items():
        lines.append(f'    "{key}": VehicleDefinition(')
        lines.append(f'        name="{v["name"]}",')
        lines.append(f'        faction="{v["faction"]}",')
        lines.append(f'        based_on="{v["based_on"]}",')
        lines.append(f'        role="{v["role"]}",')
        lines.append(f'        cost_usd={v["cost_usd"]},')
        lines.append(f"        components={v['components']!r},")
        lines.append(f'        ai_behavior="{v["ai_behavior"]}",')
        lines.append(f'        sprite="{v["sprite"]}",')
        lines.append("    ),")
    lines.append("}")

    # --- VEHICLE_PHYSICS ---
    lines.append("")
    lines.append("")
    lines.append("VEHICLE_PHYSICS: dict[str, dict] = {")
    for key, v in vehicles.items():
        phys = v["components"]["physics"]
        derived = compute_derived_physics(phys)
        lines.append(f'    "{key}": {{')
        lines.append(f'        "vehicle_type": "{key}",')
        for field in PHYSICS_FIELDS:
            val = phys[field]
            if isinstance(val, bool):
                lines.append(f'        "{field}": {val},')
            elif isinstance(val, (int, float)):
                lines.append(f'        "{field}": {fmt_float(float(val))},')
            else:
                lines.append(f'        "{field}": {val!r},')
        lines.append(f'        "drag_coefficient": {fmt_float(derived["drag_coefficient"])},')
        lines.append(
            f'        "rudder_flow_coefficient": {fmt_float(derived["rudder_flow_coefficient"])},'
        )
        lines.append("    },")
    lines.append("}")

    # --- COLLISION_POLYGONS ---
    lines.append("")
    lines.append("")
    lines.append("COLLISION_POLYGONS: dict[str, tuple[tuple[float, float], ...]] = {")
    for key, v in vehicles.items():
        poly = v["components"]["collision_polygon"]
        verts = ", ".join(f"({fmt_float(float(p[0]))}, {fmt_float(float(p[1]))})" for p in poly)
        lines.append(f'    "{key}": ({verts},),')
    lines.append("}")

    # --- MAX_HP ---
    lines.append("")
    lines.append("")
    lines.append("MAX_HP: dict[str, int] = {")
    for key, v in vehicles.items():
        hp = v["components"]["health"]["max_hp"]
        lines.append(f'    "{key}": {hp},')
    lines.append("}")

    # --- RADAR_DETECTION ---
    lines.append("")
    lines.append("")
    lines.append("RADAR_DETECTION: dict[str, float] = {")
    for key, v in vehicles.items():
        rdr = v["components"].get("radar_detection_range")
        if rdr is not None:
            lines.append(f'    "{key}": {fmt_float(float(rdr))},')
    lines.append("}")

    # --- Combat constants ---
    ac = combat["autocannon"]
    lines.append("")
    lines.append("")
    lines.append(f"AUTOCANNON_RANGE = {fmt_float(float(ac['range']))}")
    lines.append(f"AUTOCANNON_COOLDOWN = {fmt_float(float(ac['cooldown']))}")
    lines.append(f"AUTOCANNON_PROJECTILE_SPEED = {fmt_float(float(ac['projectile_speed']))}")
    lines.append(f"AUTOCANNON_PROJECTILE_LIFETIME = {fmt_float(float(ac['projectile_lifetime']))}")
    lines.append(f"AUTOCANNON_DAMAGE = {ac['damage']}")
    lines.append(
        "AUTOCANNON_HIT_RADIUS: dict[str, float] = {"
        + ", ".join(f'"{k}": {fmt_float(float(v))}' for k, v in ac["hit_radius"].items())
        + "}"
    )
    lines.append(f"AUTOCANNON_SPREAD = {fmt_float(float(ac['spread']))}")

    lines.append("")
    lines.append(f"JAM_RADIUS = {fmt_float(float(combat['jam_radius']))}")
    lines.append(f"BREACHES_TO_SINK = {combat['breaches_to_sink']}")

    qd = combat["quadcopter_damage"]
    lines.append("")
    lines.append(f"QUADCOPTER_HP_DAMAGE = {qd['hp_damage']}")
    lines.append(f"QUADCOPTER_TANKER_BREACHES = {qd['tanker_breaches']}")
    lines.append(f"QUADCOPTER_FRIGATE_BREACHES = {qd['frigate_breaches']}")

    # --- World spawns ---
    lines.append("")
    lines.append("")
    lines.append(f"WORLD_SPAWNS: dict = {world['spawns']!r}")
    lines.append("")
    return "\n".join(lines)


def generate_python_factions(factions: dict) -> str:
    lines = [
        '"""Auto-generated from shared/factions.yaml — do not edit."""',
        "",
        "from dataclasses import dataclass",
        "",
        "",
        "@dataclass(frozen=True)",
        "class FactionDefinition:",
        "    name: str",
        "    color: str",
        "    description: str",
        "",
        "",
        "FACTIONS: dict[str, FactionDefinition] = {",
    ]
    for key, f in factions.items():
        lines.append(f'    "{key}": FactionDefinition(')
        lines.append(f'        name="{f["name"]}",')
        lines.append(f'        color="{f["color"]}",')
        lines.append(f'        description="{f["description"]}",')
        lines.append("    ),")
    lines.append("}")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# TypeScript generation
# ---------------------------------------------------------------------------


def to_camel(snake: str) -> str:
    """Convert snake_case to camelCase."""
    parts = snake.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def generate_ts_vehicles(vehicles: dict, combat: dict, world: dict) -> str:
    vehicle_keys = list(vehicles.keys())
    type_union = " | ".join(f'"{k}"' for k in vehicle_keys)

    lines = [
        "// Auto-generated from shared/vehicles.yaml — do not edit.",
        "",
    ]

    # --- VehicleType ---
    lines.append(f"export type VehicleType = {type_union};")
    lines.append("")

    # --- VehicleDefinition (existing) ---
    lines.append("export interface VehicleDefinition {")
    lines.append("  readonly name: string;")
    lines.append("  readonly faction: string;")
    lines.append("  readonly basedOn: string;")
    lines.append("  readonly role: string;")
    lines.append("  readonly costUsd: number;")
    lines.append("  readonly components: Record<string, unknown>;")
    lines.append("  readonly aiBehavior: string;")
    lines.append("  readonly sprite: string;")
    lines.append("}")
    lines.append("")
    lines.append("export const VEHICLES: Record<string, VehicleDefinition> = {")
    for key, v in vehicles.items():
        lines.append(f"  {key}: {{")
        lines.append(f'    name: "{v["name"]}",')
        lines.append(f'    faction: "{v["faction"]}",')
        lines.append(f'    basedOn: "{v["based_on"]}",')
        lines.append(f'    role: "{v["role"]}",')
        lines.append(f"    costUsd: {v['cost_usd']},")
        lines.append(f"    components: {json.dumps(v['components'])},")
        lines.append(f'    aiBehavior: "{v["ai_behavior"]}",')
        lines.append(f'    sprite: "{v["sprite"]}",')
        lines.append("  },")
    lines.append("} as const;")

    # --- VehiclePhysicsData interface ---
    lines.append("")
    lines.append("export interface VehiclePhysicsData {")
    for field in PHYSICS_FIELDS:
        ts_type = "boolean" if field == "airborne" else "number"
        lines.append(f"  readonly {to_camel(field)}: {ts_type};")
    lines.append("  readonly dragCoefficient: number;")
    lines.append("  readonly rudderFlowCoefficient: number;")
    lines.append("}")
    lines.append("")

    # --- VEHICLE_PHYSICS ---
    lines.append("export const VEHICLE_PHYSICS: Record<VehicleType, VehiclePhysicsData> = {")
    for key, v in vehicles.items():
        phys = v["components"]["physics"]
        derived = compute_derived_physics(phys)
        lines.append(f"  {key}: {{")
        for field in PHYSICS_FIELDS:
            val = phys[field]
            camel = to_camel(field)
            if isinstance(val, bool):
                lines.append(f"    {camel}: {str(val).lower()},")
            else:
                lines.append(f"    {camel}: {fmt_float(float(val))},")
        lines.append(f"    dragCoefficient: {fmt_float(derived['drag_coefficient'])},")
        lines.append(f"    rudderFlowCoefficient: {fmt_float(derived['rudder_flow_coefficient'])},")
        lines.append("  },")
    lines.append("} as const;")

    # --- COLLISION_POLYGONS ---
    lines.append("")
    lines.append(
        "export const COLLISION_POLYGONS: Record<VehicleType, readonly (readonly [number, number])[]> = {"
    )
    for key, v in vehicles.items():
        poly = v["components"]["collision_polygon"]
        verts = ", ".join(f"[{fmt_float(float(p[0]))}, {fmt_float(float(p[1]))}]" for p in poly)
        lines.append(f"  {key}: [{verts}],")
    lines.append("} as const;")

    # --- MAX_HP ---
    lines.append("")
    lines.append("export const MAX_HP: Record<VehicleType, number> = {")
    for key, v in vehicles.items():
        hp = v["components"]["health"]["max_hp"]
        lines.append(f"  {key}: {hp},")
    lines.append("} as const;")

    # --- RADAR_DETECTION ---
    lines.append("")
    lines.append("export const RADAR_DETECTION: Partial<Record<VehicleType, number>> = {")
    for key, v in vehicles.items():
        rdr = v["components"].get("radar_detection_range")
        if rdr is not None:
            lines.append(f"  {key}: {fmt_float(float(rdr))},")
    lines.append("} as const;")

    # --- Combat constants ---
    ac = combat["autocannon"]
    lines.append("")
    lines.append("export const AUTOCANNON = {")
    lines.append(f"  range: {fmt_float(float(ac['range']))},")
    lines.append(f"  cooldown: {fmt_float(float(ac['cooldown']))},")
    lines.append(f"  projectileSpeed: {fmt_float(float(ac['projectile_speed']))},")
    lines.append(f"  projectileLifetime: {fmt_float(float(ac['projectile_lifetime']))},")
    lines.append(f"  damage: {ac['damage']},")
    lines.append("  hitRadius: {")
    for k, v in ac["hit_radius"].items():
        lines.append(f"    {k}: {fmt_float(float(v))},")
    lines.append("  },")
    lines.append(f"  spread: {fmt_float(float(ac['spread']))},")
    lines.append("} as const;")

    lines.append("")
    lines.append(f"export const JAM_RADIUS = {fmt_float(float(combat['jam_radius']))};")
    lines.append(f"export const BREACHES_TO_SINK = {combat['breaches_to_sink']};")

    qd = combat["quadcopter_damage"]
    lines.append("")
    lines.append("export const QUADCOPTER_DAMAGE = {")
    lines.append(f"  hpDamage: {qd['hp_damage']},")
    lines.append(f"  tankerBreaches: {qd['tanker_breaches']},")
    lines.append(f"  frigateBreaches: {qd['frigate_breaches']},")
    lines.append("} as const;")

    # --- World spawns ---
    lines.append("")
    lines.append(f"export const WORLD_SPAWNS = {json.dumps(world['spawns'])} as const;")

    lines.append("")
    return "\n".join(lines)


def generate_ts_factions(factions: dict) -> str:
    lines = [
        "// Auto-generated from shared/factions.yaml — do not edit.",
        "",
        "export interface FactionDefinition {",
        "  readonly name: string;",
        "  readonly color: string;",
        "  readonly description: string;",
        "}",
        "",
        "export const FACTIONS: Record<string, FactionDefinition> = {",
    ]
    for key, f in factions.items():
        lines.append(f"  {key}: {{")
        lines.append(f'    name: "{f["name"]}",')
        lines.append(f'    color: "{f["color"]}",')
        lines.append(f'    description: "{f["description"]}",')
        lines.append("  },")
    lines.append("} as const;")
    lines.append("")
    return "\n".join(lines)


# --- Geo ↔ game coordinate conversion (map.yaml stores [lat, lon]) ---
_ORIGIN_LON = 47.5
_ORIGIN_LAT = 30.5
_LON_SCALE = 9708
_LAT_SCALE = 10800


def _geo_to_game(p: list) -> list:
    """Convert [lat, lon] from YAML to [game_x, game_y]."""
    lat, lon = float(p[0]), float(p[1])
    return [round((lon - _ORIGIN_LON) * _LON_SCALE), round((_ORIGIN_LAT - lat) * _LAT_SCALE)]


def _game_x_from_lon(lon: float) -> float:
    return round((float(lon) - _ORIGIN_LON) * _LON_SCALE)


def _py_point(p: list) -> str:
    return f"({fmt_float(float(p[0]))}, {fmt_float(float(p[1]))})"


def _py_polygon(poly: list) -> str:
    return "(" + ", ".join(_py_point(p) for p in poly) + ",)"


def _py_polyline(line: list) -> str:
    return "[" + ", ".join(_py_point(p) for p in line) + "]"


def _ts_point(p: list) -> str:
    return f"[{fmt_float(float(p[0]))}, {fmt_float(float(p[1]))}]"


def generate_python_map_data(map_data: dict) -> str:
    lines = [
        '"""Auto-generated from shared/map.yaml — do not edit."""',
        "",
        "",
    ]
    spawns = map_data["spawns"]

    # --- Spawn points ---
    for group_name in ("iran", "us", "tanker", "quadcopter"):
        var = f"{group_name.upper()}_SPAWNS"
        lines.append(f"{var}: list[dict] = [")
        for sp in spawns.get(group_name, []):
            parts = [f'"position": {_py_point(sp["position"])}']
            if "heading" in sp:
                parts.append(f'"heading": {fmt_float(float(sp["heading"]))}')
            if "scatter_radius" in sp:
                parts.append(f'"scatter_radius": {fmt_float(float(sp["scatter_radius"]))}')
            if "group" in sp:
                parts.append(f'"group": "{sp["group"]}"')
            parts.append(f'"label": "{sp["label"]}"')
            lines.append("    {" + ", ".join(parts) + "},")
        lines.append("]")
        lines.append("")

    lines.append("US_BASES: list[dict] = [")
    for sp in spawns.get("bases", []):
        parts = [f'"position": {_py_point(sp["position"])}']
        if "heading" in sp:
            parts.append(f'"heading": {fmt_float(float(sp["heading"]))}')
        parts.append(f'"label": "{sp["label"]}"')
        lines.append("    {" + ", ".join(parts) + "},")
    lines.append("]")
    lines.append("")

    # --- Landmarks ---
    landmarks = map_data.get("landmarks") or {}
    for lm_name, var_name in [("strait_center", "STRAIT_CENTER")]:
        p = landmarks.get(lm_name)
        if p:
            lines.append(f"{var_name}: tuple[float, float] = {_py_point(p)}")
            lines.append("")

    # --- Escort zone ---
    escort_zone = map_data.get("escort_zone") or {}
    if escort_zone:
        lines.append(f"ESCORT_ZONE_WEST: float = {fmt_float(float(escort_zone['west']))}")
        lines.append(f"ESCORT_ZONE_EAST: float = {fmt_float(float(escort_zone['east']))}")
        lines.append("")

    # --- Patrol routes (QRF waypoint pairs) ---
    patrol_routes = map_data.get("patrol_routes") or {}
    if patrol_routes:
        lines.append("QRF_PATROL_ROUTES: dict[str, tuple[tuple[float, float], tuple[float, float]]] = {")
        for route_name, pts in patrol_routes.items():
            lines.append(f'    "{route_name}": ({_py_point(pts[0])}, {_py_point(pts[1])}),')
        lines.append("}")
        lines.append("")

    # --- Patrol zones (frigate areas) ---
    patrol_zones = map_data.get("patrol_zones") or {}
    if patrol_zones:
        lines.append("PATROL_ZONES: dict[str, dict] = {")
        for zone_name, z in patrol_zones.items():
            pos = _py_point(z["position"])
            r = fmt_float(float(z["radius"]))
            lines.append(f'    "{zone_name}": {{"position": {pos}, "radius": {r}}},')
        lines.append("}")
        lines.append("")

    # --- Destinations ---
    destinations = map_data.get("destinations", {})
    for dest_name, var_name in [("oman", "OMAN_DESTINATION"), ("gulf", "GULF_DESTINATION")]:
        d = destinations.get(dest_name)
        if d:
            pos = _py_point(d["position"])
            r = fmt_float(float(d["radius"]))
            lines.append(
                f'{var_name}: dict = {{"position": {pos}, "radius": {r}}}'
            )
            lines.append("")

    # --- Shipping lanes ---
    lanes = map_data["shipping_lanes"]
    for lane_name, var_name in [
        ("inbound", "LANE_INBOUND"),
        ("outbound", "LANE_OUTBOUND"),
        ("deep_water_route", "DEEP_WATER_ROUTE"),
    ]:
        lines.append(f"{var_name}: list[tuple[float, float]] = {_py_polyline(lanes[lane_name])}")
        lines.append("")

    # --- Shallow waters ---
    lines.append("SHALLOW_WATERS: list[tuple[tuple[float, float], ...]] = [")
    for poly in (map_data.get("shallow_waters") or []):
        lines.append(f"    {_py_polygon(poly)},")
    lines.append("]")
    lines.append("")

    lines.append("VERY_SHALLOW_WATERS: list[tuple[tuple[float, float], ...]] = [")
    for poly in (map_data.get("very_shallow_waters") or []):
        lines.append(f"    {_py_polygon(poly)},")
    lines.append("]")
    lines.append("")

    # --- Hazards ---
    hazards = map_data.get("hazards") or {}
    lines.append("SHOALS: list[tuple[tuple[float, float], ...]] = [")
    for poly in (hazards.get("shoals") or []):
        lines.append(f"    {_py_polygon(poly)},")
    lines.append("]")
    lines.append("")

    lines.append("ROCKS: list[dict] = [")
    for rock in (hazards.get("rocks") or []):
        parts = [f'"position": {_py_point(rock["position"])}']
        parts.append(f'"radius": {rock["radius"]}')
        if "label" in rock:
            parts.append(f'"label": "{rock["label"]}"')
        lines.append("    {" + ", ".join(parts) + "},")
    lines.append("]")
    lines.append("")

    # --- Exclusion zones ---
    lines.append("EXCLUSION_ZONES: list[dict] = [")
    for zone in map_data.get("exclusion_zones", []):
        poly = ", ".join(_py_point(p) for p in zone["polygon"])
        behaviors = ", ".join(f'"{b}"' for b in zone["behaviors"])
        lines.append("    {")
        lines.append(f'        "name": "{zone["name"]}",')
        lines.append(f'        "polygon": ({poly},),')
        lines.append(f'        "behaviors": {{{behaviors}}},')
        lines.append("    },")
    lines.append("]")
    lines.append("")
    return "\n".join(lines)


def generate_ts_map_data(map_data: dict) -> str:
    lines = [
        "// Auto-generated from shared/map.yaml — do not edit.",
        "",
        "export type Point = [number, number];",
        "export type Polygon = Point[];",
        "export type Polyline = Point[];",
        "",
        "export interface SpawnPoint {",
        "\treadonly position: Point;",
        "\treadonly heading?: number;",
        "\treadonly scatterRadius?: number;",
        "\treadonly group?: string;",
        "\treadonly label: string;",
        "}",
        "",
        "export interface Rock {",
        "\treadonly position: Point;",
        "\treadonly radius: number;",
        "\treadonly label?: string;",
        "}",
        "",
        "export interface ExclusionZone {",
        "\treadonly name: string;",
        "\treadonly polygon: readonly Point[];",
        "\treadonly behaviors: readonly string[];",
        "}",
        "",
    ]

    spawns = map_data["spawns"]

    # --- Spawn points ---
    for group_name, var_name in [
        ("iran", "IRAN_SPAWNS"),
        ("us", "US_SPAWNS"),
        ("tanker", "TANKER_SPAWNS"),
        ("quadcopter", "QUADCOPTER_SPAWNS"),
    ]:
        lines.append(f"export const {var_name}: readonly SpawnPoint[] = [")
        for sp in spawns.get(group_name, []):
            parts = [f"position: {_ts_point(sp['position'])}"]
            if "heading" in sp:
                parts.append(f"heading: {fmt_float(float(sp['heading']))}")
            if "scatter_radius" in sp:
                parts.append(f"scatterRadius: {fmt_float(float(sp['scatter_radius']))}")
            if "group" in sp:
                parts.append(f'group: "{sp["group"]}"')
            parts.append(f'label: "{sp["label"]}"')
            lines.append("\t{ " + ", ".join(parts) + " },")
        lines.append("] as const;")
        lines.append("")

    lines.append("export const US_BASES: readonly SpawnPoint[] = [")
    for sp in spawns.get("bases", []):
        parts = [f"position: {_ts_point(sp['position'])}"]
        if "heading" in sp:
            parts.append(f"heading: {fmt_float(float(sp['heading']))}")
        parts.append(f'label: "{sp["label"]}"')
        lines.append("\t{ " + ", ".join(parts) + " },")
    lines.append("] as const;")
    lines.append("")

    # --- Landmarks ---
    landmarks = map_data.get("landmarks") or {}
    for lm_name, var_name in [("strait_center", "STRAIT_CENTER")]:
        p = landmarks.get(lm_name)
        if p:
            lines.append(f"export const {var_name}: Point = {_ts_point(p)};")
            lines.append("")

    # --- Escort zone ---
    escort_zone = map_data.get("escort_zone") or {}
    if escort_zone:
        lines.append(f"export const ESCORT_ZONE_WEST: number = {fmt_float(float(escort_zone['west']))};")
        lines.append(f"export const ESCORT_ZONE_EAST: number = {fmt_float(float(escort_zone['east']))};")
        lines.append("")

    # --- Patrol routes (QRF waypoint pairs) ---
    patrol_routes = map_data.get("patrol_routes") or {}
    if patrol_routes:
        lines.append("export const QRF_PATROL_ROUTES: Record<string, readonly [Point, Point]> = {")
        for route_name, pts in patrol_routes.items():
            lines.append(f'\t{route_name}: [{_ts_point(pts[0])}, {_ts_point(pts[1])}],')
        lines.append("} as const;")
        lines.append("")

    # --- Patrol zones (frigate areas) ---
    patrol_zones = map_data.get("patrol_zones") or {}
    if patrol_zones:
        lines.append("export interface PatrolZone {")
        lines.append("\treadonly position: Point;")
        lines.append("\treadonly radius: number;")
        lines.append("}")
        lines.append("")
        lines.append("export const PATROL_ZONES: Record<string, PatrolZone> = {")
        for zone_name, z in patrol_zones.items():
            pos = _ts_point(z["position"])
            r = fmt_float(float(z["radius"]))
            lines.append(f'\t{zone_name}: {{ position: {pos}, radius: {r} }},')
        lines.append("} as const;")
        lines.append("")

    # --- Destinations ---
    lines.append("export interface Destination {")
    lines.append("\treadonly position: Point;")
    lines.append("\treadonly radius: number;")
    lines.append("}")
    lines.append("")
    destinations = map_data.get("destinations", {})
    for dest_name, var_name in [("oman", "OMAN_DESTINATION"), ("gulf", "GULF_DESTINATION")]:
        d = destinations.get(dest_name)
        if d:
            pos = _ts_point(d["position"])
            r = fmt_float(float(d["radius"]))
            lines.append(f"export const {var_name}: Destination = {{ position: {pos}, radius: {r} }};")
            lines.append("")

    # --- Shipping lanes ---
    lanes = map_data["shipping_lanes"]
    for lane_name, var_name in [
        ("inbound", "LANE_INBOUND"),
        ("outbound", "LANE_OUTBOUND"),
        ("deep_water_route", "DEEP_WATER_ROUTE"),
    ]:
        pts = ", ".join(_ts_point(p) for p in lanes[lane_name])
        lines.append(f"export const {var_name}: readonly Point[] = [{pts}] as const;")
        lines.append("")

    # --- Shallow waters ---
    lines.append("export const SHALLOW_WATERS: readonly Polygon[] = [")
    for poly in (map_data.get("shallow_waters") or []):
        pts = ", ".join(_ts_point(p) for p in poly)
        lines.append(f"\t[{pts}],")
    lines.append("] as const;")
    lines.append("")

    lines.append("export const VERY_SHALLOW_WATERS: readonly Polygon[] = [")
    for poly in (map_data.get("very_shallow_waters") or []):
        pts = ", ".join(_ts_point(p) for p in poly)
        lines.append(f"\t[{pts}],")
    lines.append("] as const;")
    lines.append("")

    # --- Hazards ---
    hazards = map_data.get("hazards") or {}
    lines.append("export const SHOALS: readonly Polygon[] = [")
    for poly in (hazards.get("shoals") or []):
        pts = ", ".join(_ts_point(p) for p in poly)
        lines.append(f"\t[{pts}],")
    lines.append("] as const;")
    lines.append("")

    lines.append("export const ROCKS: readonly Rock[] = [")
    for rock in (hazards.get("rocks") or []):
        parts = [f"position: {_ts_point(rock['position'])}"]
        parts.append(f"radius: {rock['radius']}")
        if "label" in rock:
            parts.append(f'label: "{rock["label"]}"')
        lines.append("\t{ " + ", ".join(parts) + " },")
    lines.append("] as const;")
    lines.append("")

    # --- Exclusion zones ---
    lines.append("export const EXCLUSION_ZONES: readonly ExclusionZone[] = [")
    for zone in map_data.get("exclusion_zones", []):
        lines.append("\t{")
        lines.append(f'\t\tname: "{zone["name"]}",')
        lines.append("\t\tpolygon: [")
        for p in zone["polygon"]:
            lines.append(f"\t\t\t{_ts_point(p)},")
        lines.append("\t\t],")
        lines.append("\t\tbehaviors: [")
        for b in zone["behaviors"]:
            lines.append(f'\t\t\t"{b}",')
        lines.append("\t\t],")
        lines.append("\t},")
    lines.append("] as const;")
    lines.append("")
    return "\n".join(lines)


def _preprocess_map_data(raw: dict) -> dict:
    """Convert map.yaml lat/lon positions to game coordinates for codegen."""
    import copy
    data = copy.deepcopy(raw)

    # Spawns
    for group in data.get("spawns", {}).values():
        for sp in group:
            sp["position"] = _geo_to_game(sp["position"])

    # Landmarks
    for key, val in (data.get("landmarks") or {}).items():
        data["landmarks"][key] = _geo_to_game(val)

    # Escort zone (scalar longitude → game x)
    ez = data.get("escort_zone") or {}
    if "west" in ez:
        ez["west"] = _game_x_from_lon(ez["west"])
    if "east" in ez:
        ez["east"] = _game_x_from_lon(ez["east"])

    # Patrol routes (pairs of points)
    for name, pts in (data.get("patrol_routes") or {}).items():
        data["patrol_routes"][name] = [_geo_to_game(pts[0]), _geo_to_game(pts[1])]

    # Patrol zones (position + radius)
    for name, z in (data.get("patrol_zones") or {}).items():
        z["position"] = _geo_to_game(z["position"])

    # Destinations
    for name, d in (data.get("destinations") or {}).items():
        d["position"] = _geo_to_game(d["position"])

    # Shipping lanes
    for lane_name, pts in (data.get("shipping_lanes") or {}).items():
        data["shipping_lanes"][lane_name] = [_geo_to_game(p) for p in pts]

    # Shallow/very shallow waters
    for key in ("shallow_waters", "very_shallow_waters"):
        polys = data.get(key) or []
        data[key] = [[_geo_to_game(p) for p in poly] for poly in polys]

    # Hazards
    hazards = data.get("hazards") or {}
    hazards["shoals"] = [[_geo_to_game(p) for p in poly] for poly in (hazards.get("shoals") or [])]
    for rock in (hazards.get("rocks") or []):
        rock["position"] = _geo_to_game(rock["position"])

    # Exclusion zones
    for zone in data.get("exclusion_zones", []):
        zone["polygon"] = [_geo_to_game(p) for p in zone["polygon"]]

    return data


def main() -> None:
    vehicles_data = load_yaml("vehicles.yaml")
    factions_data = load_yaml("factions.yaml")
    map_data = _preprocess_map_data(load_yaml("map.yaml"))

    vehicles = vehicles_data["vehicles"]
    combat = vehicles_data["combat"]
    world = vehicles_data["world"]
    factions = factions_data["factions"]

    # Ensure output directories exist
    SERVER_OUT.mkdir(parents=True, exist_ok=True)
    CLIENT_OUT.mkdir(parents=True, exist_ok=True)

    # Write Python
    (SERVER_OUT / "__init__.py").write_text("")
    (SERVER_OUT / "vehicles.py").write_text(generate_python_vehicles(vehicles, combat, world))
    (SERVER_OUT / "factions.py").write_text(generate_python_factions(factions))
    (SERVER_OUT / "map_data.py").write_text(generate_python_map_data(map_data))

    # Write TypeScript
    (CLIENT_OUT / "vehicles.ts").write_text(generate_ts_vehicles(vehicles, combat, world))
    (CLIENT_OUT / "factions.ts").write_text(generate_ts_factions(factions))
    (CLIENT_OUT / "map_data.ts").write_text(generate_ts_map_data(map_data))

    # Clean up old exclusion_zones files
    for old_file in [
        SERVER_OUT / "exclusion_zones.py",
        CLIENT_OUT / "exclusion_zones.ts",
    ]:
        if old_file.exists():
            old_file.unlink()
            print(f"  Removed old {old_file.name}")

    print(f"Generated Python definitions in {SERVER_OUT}")
    print(f"Generated TypeScript definitions in {CLIENT_OUT}")


if __name__ == "__main__":
    main()
