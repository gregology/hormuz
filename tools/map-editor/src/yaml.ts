import type { EditableMapData, EditableSpawn, EditableRock, EditableZone, AreaWithRadius } from "./editor-state";

// Game coord → lat/lon conversion (editor works in game coords internally,
// YAML output uses [lat, lon] decimal degrees)
const ORIGIN_LON = 47.5;
const ORIGIN_LAT = 30.5;
const LON_SCALE = 9708;
const LAT_SCALE = 10800;

function toLatLon(gx: number, gy: number): [number, number] {
	return [round5(ORIGIN_LAT - gy / LAT_SCALE), round5(ORIGIN_LON + gx / LON_SCALE)];
}

function lonFromGameX(gx: number): number {
	return round5(ORIGIN_LON + gx / LON_SCALE);
}

function round5(n: number): number {
	return Math.round(n * 100000) / 100000;
}

function fmtGeo(n: number): string {
	return n.toFixed(5);
}

function fmtPos(gx: number, gy: number): string {
	const [lat, lon] = toLatLon(gx, gy);
	return `[${fmtGeo(lat)}, ${fmtGeo(lon)}]`;
}

export function exportYAML(data: EditableMapData): string {
	const lines: string[] = [
		"# Map data — all hand-authored spatial data for the Strait of Hormuz.",
		"#",
		"# Positions are [lat, lon] in decimal degrees.",
		"# Distances (scatter_radius, radius) are in game units (~10 units ≈ 1m).",
		"# Codegen (pnpm generate) converts lat/lon to game coordinates.",
		"#",
		"# Edit visually with the map editor: pnpm dev:map-editor",
		"# After editing, run: pnpm generate",
		"",
	];

	// --- Spawns ---
	lines.push("spawns:");
	writeSpawnGroup(lines, "iran", data.spawns.iran);
	writeSpawnGroup(lines, "us", data.spawns.us);
	writeSpawnGroup(lines, "tanker", data.spawns.tanker);
	writeSpawnGroup(lines, "quadcopter", data.spawns.quadcopter);
	writeSpawnGroup(lines, "bases", data.spawns.bases);

	// --- Landmarks ---
	lines.push("landmarks:");
	lines.push(`  strait_center: ${fmtPos(data.landmarks.straitCenter[0], data.landmarks.straitCenter[1])}`);

	// --- Escort zone ---
	lines.push("escort_zone:");
	lines.push(`  west: ${fmtGeo(lonFromGameX(data.escortZone.west))}`);
	lines.push(`  east: ${fmtGeo(lonFromGameX(data.escortZone.east))}`);

	// --- Patrol routes ---
	lines.push("patrol_routes:");
	for (const [name, pts] of Object.entries(data.patrolRoutes)) {
		lines.push(`  ${name}: [${fmtPos(pts[0][0], pts[0][1])}, ${fmtPos(pts[1][0], pts[1][1])}]`);
	}

	// --- Patrol zones ---
	lines.push("patrol_zones:");
	for (const [name, zone] of Object.entries(data.patrolZones)) {
		lines.push(`  ${name}: ${fmtArea(zone)}`);
	}

	// --- Destinations ---
	lines.push("destinations:");
	lines.push(`  oman: ${fmtArea(data.destinations.oman)}`);
	lines.push(`  gulf: ${fmtArea(data.destinations.gulf)}`);

	// --- Shipping lanes ---
	lines.push("shipping_lanes:");
	writePolyline(lines, "inbound", data.lanes.inbound);
	writePolyline(lines, "outbound", data.lanes.outbound);
	writePolyline(lines, "deep_water_route", data.lanes.deepWaterRoute);

	// --- Shallow waters ---
	lines.push("shallow_waters:");
	for (const poly of data.shallowWaters) writePolygon(lines, poly);

	lines.push("very_shallow_waters:");
	for (const poly of data.veryShallowWaters) writePolygon(lines, poly);

	// --- Hazards ---
	lines.push("hazards:");
	lines.push("  shoals:");
	for (const poly of data.shoals) {
		lines.push("  - " + formatPointArray(poly));
	}
	lines.push("  rocks:");
	for (const rock of data.rocks) writeRock(lines, rock);

	// --- Exclusion zones ---
	lines.push("exclusion_zones:");
	for (const zone of data.exclusionZones) writeExclusionZone(lines, zone);

	return lines.join("\n") + "\n";
}

function fmtArea(a: AreaWithRadius): string {
	return `{position: ${fmtPos(a.position[0], a.position[1])}, radius: ${a.radius}}`;
}

function writeSpawnGroup(lines: string[], name: string, spawns: EditableSpawn[]): void {
	lines.push(`  ${name}:`);
	for (const sp of spawns) {
		const parts = [`position: ${fmtPos(sp.position[0], sp.position[1])}`];
		if (sp.heading !== 0 || name !== "quadcopter") {
			parts.push(`heading: ${roundNum(sp.heading)}`);
		}
		parts.push(`scatter_radius: ${sp.scatterRadius}`);
		if (sp.group) parts.push(`group: ${sp.group}`);
		parts.push(`label: ${sp.label}`);
		lines.push(`  - {${parts.join(", ")}}`);
	}
}

function writePolyline(lines: string[], name: string, pts: [number, number][]): void {
	lines.push(`  ${name}:`);
	for (const p of pts) {
		lines.push(`  - ${fmtPos(p[0], p[1])}`);
	}
}

function writePolygon(lines: string[], poly: [number, number][]): void {
	lines.push("- " + formatPointArray(poly));
}

function formatPointArray(pts: [number, number][]): string {
	if (pts.length <= 6) {
		const inner = pts.map((p) => fmtPos(p[0], p[1])).join(", ");
		return `[${inner}]`;
	}
	const result = [""];
	for (const p of pts) {
		result.push(`  - ${fmtPos(p[0], p[1])}`);
	}
	return result.join("\n");
}

function writeRock(lines: string[], rock: EditableRock): void {
	const parts = [`position: ${fmtPos(rock.position[0], rock.position[1])}`];
	parts.push(`radius: ${rock.radius}`);
	if (rock.label) parts.push(`label: ${rock.label}`);
	lines.push(`  - {${parts.join(", ")}}`);
}

function writeExclusionZone(lines: string[], zone: EditableZone): void {
	lines.push(`- name: ${zone.name}`);
	lines.push("  polygon:");
	for (const p of zone.polygon) {
		lines.push(`  - ${fmtPos(p[0], p[1])}`);
	}
	lines.push("  behaviors:");
	for (const b of zone.behaviors) {
		lines.push(`  - ${b}`);
	}
}

function roundNum(n: number): number {
	return Math.round(n * 100000) / 100000;
}
