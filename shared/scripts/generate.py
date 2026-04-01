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
    lines.append("  readonly components: Record<string, Record<string, unknown>>;")
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


def main() -> None:
    vehicles_data = load_yaml("vehicles.yaml")
    factions_data = load_yaml("factions.yaml")

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

    # Write TypeScript
    (CLIENT_OUT / "vehicles.ts").write_text(generate_ts_vehicles(vehicles, combat, world))
    (CLIENT_OUT / "factions.ts").write_text(generate_ts_factions(factions))

    print(f"Generated Python definitions in {SERVER_OUT}")
    print(f"Generated TypeScript definitions in {CLIENT_OUT}")


if __name__ == "__main__":
    main()
