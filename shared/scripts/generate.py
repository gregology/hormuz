#!/usr/bin/env python3
"""Generate Python and TypeScript definitions from shared YAML source-of-truth files."""

import sys
from pathlib import Path

import yaml

SHARED_DIR = Path(__file__).parent.parent
SERVER_OUT = SHARED_DIR.parent / "server" / "src" / "hormuz" / "generated"
CLIENT_OUT = SHARED_DIR.parent / "client" / "src" / "generated"


def load_yaml(name: str) -> dict:
    with open(SHARED_DIR / name) as f:
        return yaml.safe_load(f)


def generate_python_vehicles(vehicles: dict) -> str:
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


def generate_ts_vehicles(vehicles: dict) -> str:
    lines = [
        "// Auto-generated from shared/vehicles.yaml — do not edit.",
        "",
        "export interface VehicleDefinition {",
        "  readonly name: string;",
        "  readonly faction: string;",
        "  readonly basedOn: string;",
        "  readonly role: string;",
        "  readonly costUsd: number;",
        "  readonly components: Record<string, Record<string, unknown>>;",
        "  readonly aiBehavior: string;",
        "  readonly sprite: string;",
        "}",
        "",
        "export const VEHICLES: Record<string, VehicleDefinition> = {",
    ]
    for key, v in vehicles.items():
        import json

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
    factions = factions_data["factions"]

    # Ensure output directories exist
    SERVER_OUT.mkdir(parents=True, exist_ok=True)
    CLIENT_OUT.mkdir(parents=True, exist_ok=True)

    # Write Python
    (SERVER_OUT / "__init__.py").write_text("")
    (SERVER_OUT / "vehicles.py").write_text(generate_python_vehicles(vehicles))
    (SERVER_OUT / "factions.py").write_text(generate_python_factions(factions))

    # Write TypeScript
    (CLIENT_OUT / "vehicles.ts").write_text(generate_ts_vehicles(vehicles))
    (CLIENT_OUT / "factions.ts").write_text(generate_ts_factions(factions))

    print(f"Generated Python definitions in {SERVER_OUT}")
    print(f"Generated TypeScript definitions in {CLIENT_OUT}")


if __name__ == "__main__":
    main()
