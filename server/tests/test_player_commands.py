"""Players' input commands drive their vehicles, one command per tick."""

import esper
import pytest

from hormuz import main
from hormuz.commands import CommandBuffer
from hormuz.components import Faction, Health, PlayerControl, Transform, VehiclePhysics
from hormuz.controls import KEY_FORWARD, KEY_LEFT
from hormuz.generated.vehicles import JAM_RADIUS, VEHICLE_PHYSICS
from hormuz.protocol import ControlledVehicle

PLAYER = 1


@pytest.fixture(autouse=True)
def _fresh_players(monkeypatch):
    monkeypatch.setattr(main, "player_entities", {})
    monkeypatch.setattr(main, "command_buffers", {})


def vehicle(vehicle_type: str, x: float = 0.0, y: float = 0.0) -> int:
    return esper.create_entity(
        Transform(x=x, y=y),
        VehiclePhysics(**VEHICLE_PHYSICS[vehicle_type]),
        Health(100, 100),
        Faction("iran"),
    )


def drive(vehicle_type: str, x: float = 0.0, y: float = 0.0) -> tuple[int, CommandBuffer]:
    ent = vehicle(vehicle_type, x, y)
    esper.add_component(ent, PlayerControl(connection_id=PLAYER))
    main.player_entities[PLAYER] = ent
    main.command_buffers[PLAYER] = CommandBuffer()
    return ent, main.command_buffers[PLAYER]


def test_each_tick_applies_the_next_command_and_snapshots_report_it():
    ent, commands = drive("quadcopter")
    commands.push({"sequence": 1, "keys": KEY_FORWARD})
    commands.push({"sequence": 2, "keys": KEY_FORWARD | KEY_LEFT})
    control = esper.component_for_entity(ent, PlayerControl)

    main.apply_player_commands()
    assert (control.throttle, control.rudder) == (1.0, 0.0)
    assert main.controlled_vehicle(PLAYER) == ControlledVehicle(ent, 1, 1)

    main.apply_player_commands()
    assert (control.throttle, control.rudder) == (1.0, -1.0)
    assert main.controlled_vehicle(PLAYER) == ControlledVehicle(ent, 2, 0)


@pytest.mark.parametrize(("vehicle_type", "rudder"), [("shahed", 0.0), ("quadcopter", -1.0)])
def test_only_shaheds_lose_steering_within_a_frigates_jamming_range(vehicle_type, rudder):
    ent, commands = drive(vehicle_type)
    frigate = vehicle("frigate", x=JAM_RADIUS * 0.9)
    esper.component_for_entity(frigate, Faction).name = "us"
    commands.push({"sequence": 1, "keys": KEY_FORWARD | KEY_LEFT})
    main.apply_player_commands()
    assert esper.component_for_entity(ent, PlayerControl).rudder == rudder
