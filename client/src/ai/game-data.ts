/**
 * Build the static game-data table injected into the AI VM as "ai.gamedata".
 * Derived from generated map/vehicle data (source of truth: shared YAML).
 */

import {
	EXCLUSION_ZONES,
	GULF_DESTINATION,
	LANE_ALT_INBOUND,
	LANE_ALT_OUTBOUND,
	OMAN_DESTINATION,
	SPEEDBOAT_SPAWNS,
	STRAIT_CENTER,
} from "../generated/map_data";
import { DETECTION_RANGE, JAM_RADIUS } from "../generated/vehicles";
import type { AIGameData } from "./lua-host";

type Point = [number, number];

function copyPoints(points: readonly (readonly [number, number])[]): Point[] {
	return points.map((p) => [p[0], p[1]]);
}

export function buildClientGameData(): AIGameData {
	const detectionRanges: Record<string, Record<string, number>> = {};
	for (const [observer, targets] of Object.entries(DETECTION_RANGE)) {
		if (!targets) continue;
		const t: Record<string, number> = {};
		for (const [target, range] of Object.entries(targets)) {
			if (range !== undefined) t[target] = range;
		}
		detectionRanges[observer] = t;
	}

	const outbound = copyPoints(LANE_ALT_OUTBOUND);
	const inbound = copyPoints(LANE_ALT_INBOUND);

	return {
		lanes: { outbound, inbound },
		routes: {
			oman: {
				route: outbound,
				exit: [OMAN_DESTINATION.position[0], OMAN_DESTINATION.position[1]],
			},
			gulf: {
				route: inbound,
				exit: [GULF_DESTINATION.position[0], GULF_DESTINATION.position[1]],
			},
		},
		strait_center: [STRAIT_CENTER[0], STRAIT_CENTER[1]],
		exclusion_zones: EXCLUSION_ZONES.map((z) => ({
			name: z.name,
			polygon: copyPoints(z.polygon),
			behaviors: [...z.behaviors],
		})),
		speedboat_homes: SPEEDBOAT_SPAWNS.map((s) => [
			s.position[0],
			s.position[1],
		]),
		detection_ranges: detectionRanges,
		jam_radius: JAM_RADIUS,
	};
}
