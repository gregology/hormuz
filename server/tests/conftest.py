"""Shared test fixtures."""

import uuid

import esper
import pytest


@pytest.fixture(autouse=True)
def _isolated_esper_world():
    """Give each test an isolated esper world so processors don't leak."""
    world_name = str(uuid.uuid4())
    esper.switch_world(world_name)
    yield
    esper.switch_world("default")
    esper.delete_world(world_name)
