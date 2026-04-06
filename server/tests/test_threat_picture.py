"""Tests for the coalition threat picture system."""

import esper
import pytest

from hormuz.components import BotControl, Faction, Health, Transform, VehiclePhysics
from hormuz.systems.bot_ai import BotAIProcessor
from hormuz.systems.threat_picture import (
    build_threat_picture,
    clear,
    get_all_us_threats,
    get_threats_near,
)


@pytest.fixture(autouse=True)
def _clean_threat_picture():
    clear()
    yield
    clear()


class TestBuildThreatPicture:
    def test_frigate_detects_shahed_in_range(self):
        # Frigate detection range for shahed is ~2000u
        radar_vessels = [("frigate", 0.0, 0.0, "us")]
        enemy_vessels = [(1, 1500.0, 0.0, "shahed")]
        build_threat_picture(radar_vessels, enemy_vessels)
        threats = get_all_us_threats()
        assert len(threats) == 1
        assert threats[0][0] == 1

    def test_frigate_does_not_detect_shahed_beyond_range(self):
        # Frigate -> shahed range is ~2000u, place at 3000u
        radar_vessels = [("frigate", 0.0, 0.0, "us")]
        enemy_vessels = [(1, 3000.0, 0.0, "shahed")]
        build_threat_picture(radar_vessels, enemy_vessels)
        assert len(get_all_us_threats()) == 0

    def test_frigate_detects_speedboat_at_medium_range(self):
        # Frigate -> speedboat range is ~4000u
        radar_vessels = [("frigate", 0.0, 0.0, "us")]
        enemy_vessels = [(1, 3500.0, 0.0, "speedboat")]
        build_threat_picture(radar_vessels, enemy_vessels)
        assert len(get_all_us_threats()) == 1

    def test_tanker_barely_detects_speedboat(self):
        # Tanker -> speedboat range is ~150u
        radar_vessels = [("oil_tanker", 0.0, 0.0, "civilian")]
        enemy_vessels = [(1, 100.0, 0.0, "speedboat")]
        build_threat_picture(radar_vessels, enemy_vessels)
        assert len(get_all_us_threats()) == 1

    def test_tanker_cannot_detect_distant_speedboat(self):
        # Tanker -> speedboat range is ~505u, place at 800u
        radar_vessels = [("oil_tanker", 0.0, 0.0, "civilian")]
        enemy_vessels = [(1, 800.0, 0.0, "speedboat")]
        build_threat_picture(radar_vessels, enemy_vessels)
        assert len(get_all_us_threats()) == 0

    def test_coalition_sharing_tanker_detection_visible_to_frigates(self):
        # Tanker detects nearby speedboat, frigate is far away.
        # The detection should still appear in the US coalition picture.
        radar_vessels = [
            ("oil_tanker", 1000.0, 0.0, "civilian"),
            ("frigate", 50000.0, 0.0, "us"),
        ]
        enemy_vessels = [(1, 1100.0, 0.0, "speedboat")]
        build_threat_picture(radar_vessels, enemy_vessels)
        threats = get_all_us_threats()
        assert len(threats) == 1

    def test_no_duplicate_detections(self):
        # Both frigate and tanker can detect the same enemy
        radar_vessels = [
            ("frigate", 0.0, 0.0, "us"),
            ("oil_tanker", 100.0, 0.0, "civilian"),
        ]
        enemy_vessels = [(1, 50.0, 0.0, "speedboat")]
        build_threat_picture(radar_vessels, enemy_vessels)
        assert len(get_all_us_threats()) == 1

    def test_vehicle_without_radar_detects_nothing(self):
        # Speedboats and trucks have no radar block
        radar_vessels = [("speedboat", 0.0, 0.0, "iran")]
        enemy_vessels = [(1, 10.0, 0.0, "oil_tanker")]
        build_threat_picture(radar_vessels, enemy_vessels)
        assert len(get_all_us_threats()) == 0


class TestGetThreatsNear:
    def test_returns_threats_within_radius(self):
        radar_vessels = [("frigate", 0.0, 0.0, "us")]
        enemy_vessels = [
            (1, 500.0, 0.0, "speedboat"),
            (2, 1500.0, 0.0, "shahed"),
            (3, 10000.0, 0.0, "speedboat"),
        ]
        build_threat_picture(radar_vessels, enemy_vessels)
        # Query around (1000, 0) with radius 2000u
        nearby = get_threats_near(1000.0, 0.0, 2000.0 * 2000.0)
        ids = {t[0] for t in nearby}
        assert 1 in ids
        assert 2 in ids
        assert 3 not in ids

    def test_returns_empty_when_no_threats(self):
        radar_vessels = [("frigate", 0.0, 0.0, "us")]
        enemy_vessels = []
        build_threat_picture(radar_vessels, enemy_vessels)
        assert get_threats_near(0.0, 0.0, 10000.0) == []


class TestEscortThreatBoost:
    """Verify that frigates preferentially escort tankers near detected threats."""

    @pytest.fixture(autouse=True)
    def _ecs_world(self):
        world = f"test_escort_threat_{id(self)}"
        esper.switch_world(world)
        yield
        esper.switch_world("default")
        esper.delete_world(world)

    def test_frigate_prefers_threatened_tanker(self):
        # Two tankers at equal distance from frigate. One has a speedboat nearby.
        # The speedboat must be within frigate radar range (~4000u for speedboat)
        # so it appears in the coalition threat picture.
        esper.create_entity(
            Transform(x=3000.0, y=0.0, heading=0, speed=5.0),
            VehiclePhysics(vehicle_type="oil_tanker", max_speed=15, size=220),
            Faction("civilian"),
            Health(100, 100),
        )
        threatened_tanker = esper.create_entity(
            Transform(x=-3000.0, y=0.0, heading=0, speed=5.0),
            VehiclePhysics(vehicle_type="oil_tanker", max_speed=15, size=220),
            Faction("civilian"),
            Health(100, 100),
        )
        # Speedboat near the threatened tanker AND within frigate radar range
        esper.create_entity(
            Transform(x=-3200.0, y=0.0, heading=0, speed=10.0),
            VehiclePhysics(vehicle_type="speedboat", max_speed=46, size=13),
            Faction("iran"),
            Health(30, 30),
            BotControl("swarm_attack"),
        )
        # Frigate equidistant from both tankers at origin
        frigate = esper.create_entity(
            Transform(x=0.0, y=0.0, heading=0, speed=10.0),
            VehiclePhysics(vehicle_type="frigate", max_speed=25, size=100),
            Faction("us"),
            Health(300, 300),
            BotControl("escort"),
        )

        proc = BotAIProcessor()
        esper.add_processor(proc)
        esper.process(dt=0.05)

        bot = esper.component_for_entity(frigate, BotControl)
        # Frigate should pick the threatened tanker due to threat boost
        assert bot.target_entity == threatened_tanker
