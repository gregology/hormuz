"""Combat processor — shahed-tanker collision kills both."""


import esper

from hormuz.components import (
    BotControl,
    Collidable,
    Health,
    PlayerControl,
    RespawnTimer,
    Transform,
    VehiclePhysics,
)


class CombatProcessor(esper.Processor):
    def __init__(self) -> None:
        super().__init__()
        # Events generated this tick — consumed by networking
        self.events: list[dict] = []

    def process(self, dt: float = 0.05) -> None:
        self.events.clear()

        shaheds = [
            (ent, tf, col)
            for ent, (tf, phys, col, health) in esper.get_components(
                Transform, VehiclePhysics, Collidable, Health
            )
            if phys.vehicle_type == "shahed" and health.hp > 0
        ]

        tankers = [
            (ent, tf, col)
            for ent, (tf, phys, col, health) in esper.get_components(
                Transform, VehiclePhysics, Collidable, Health
            )
            if phys.vehicle_type == "oil_tanker" and health.hp > 0
        ]

        hit_shaheds: set[int] = set()

        for s_ent, s_tf, s_col in shaheds:
            if s_ent in hit_shaheds:
                continue
            for t_ent, t_tf, t_col in tankers:
                dx = t_tf.x - s_tf.x
                dy = t_tf.y - s_tf.y
                dist_sq = dx * dx + dy * dy
                hit_dist = s_col.radius + t_col.radius
                if dist_sq < hit_dist * hit_dist:
                    self._kill(s_ent, "iran")
                    self._kill(t_ent, "tanker")
                    hit_shaheds.add(s_ent)

                    # Explosion event at midpoint
                    mid_x = (s_tf.x + t_tf.x) / 2
                    mid_y = (s_tf.y + t_tf.y) / 2
                    self.events.append({"type": "explosion", "x": mid_x, "y": mid_y})
                    break

    def _kill(self, ent: int, spawn_type: str) -> None:
        health = esper.component_for_entity(ent, Health)
        health.hp = 0

        # Remove control components during respawn
        if esper.has_component(ent, BotControl):
            esper.remove_component(ent, BotControl)
        if esper.has_component(ent, PlayerControl):
            esper.remove_component(ent, PlayerControl)

        # Add respawn timer
        if not esper.has_component(ent, RespawnTimer):
            esper.add_component(ent, RespawnTimer(remaining=3.0))
