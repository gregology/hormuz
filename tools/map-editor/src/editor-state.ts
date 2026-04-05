import * as MapData from "../../../client/src/generated/map_data";

// ---------------------------------------------------------------------------
// Editable data types (mutable versions of generated readonly data)
// ---------------------------------------------------------------------------

export interface EditableZone {
	name: string;
	polygon: [number, number][];
	behaviors: string[];
}

export interface EditableSpawn {
	position: [number, number];
	heading: number;
	scatterRadius: number;
	group: string;
	label: string;
}

export interface EditableRock {
	position: [number, number];
	radius: number;
	label: string;
}

export interface AreaWithRadius {
	position: [number, number];
	radius: number;
}

export interface EditableMapData {
	exclusionZones: EditableZone[];
	spawns: {
		iran: EditableSpawn[];
		us: EditableSpawn[];
		tanker: EditableSpawn[];
		quadcopter: EditableSpawn[];
		bases: EditableSpawn[];
	};
	landmarks: {
		straitCenter: [number, number];
	};
	escortZone: {
		west: number;
		east: number;
	};
	patrolRoutes: Record<string, [[number, number], [number, number]]>;
	patrolZones: Record<string, AreaWithRadius>;
	destinations: {
		oman: AreaWithRadius;
		gulf: AreaWithRadius;
	};
	shallowWaters: [number, number][][];
	veryShallowWaters: [number, number][][];
	shoals: [number, number][][];
	rocks: EditableRock[];
	lanes: {
		inbound: [number, number][];
		outbound: [number, number][];
		deepWaterRoute: [number, number][];
	};
}

// ---------------------------------------------------------------------------
// Layer definitions
// ---------------------------------------------------------------------------

export type LayerKind = "polygon" | "point" | "polyline";

export interface LayerDef {
	key: string;
	label: string;
	kind: LayerKind;
	category: string;
}

export const LAYERS: LayerDef[] = [
	{ key: "exclusionZones", label: "Exclusion Zones", kind: "polygon", category: "Zones" },
	{ key: "spawn_iran", label: "Shahed Spawns", kind: "point", category: "Spawns" },
	{ key: "spawn_us", label: "Frigate Spawns", kind: "point", category: "Spawns" },
	{ key: "spawn_tanker", label: "Tanker Spawns", kind: "point", category: "Spawns" },
	{ key: "spawn_quadcopter", label: "Quadcopter Spawns", kind: "point", category: "Spawns" },
	{ key: "spawn_bases", label: "US Bases", kind: "point", category: "Spawns" },
	{ key: "landmark_straitCenter", label: "Strait Center", kind: "point", category: "Landmarks" },
	{ key: "dest_oman", label: "Oman Destination", kind: "point", category: "Destinations" },
	{ key: "dest_gulf", label: "Gulf Destination", kind: "point", category: "Destinations" },
	{ key: "patrolZone_strait_west", label: "Strait West Patrol", kind: "point", category: "Patrol" },
	{ key: "patrolZone_oman_approach", label: "Oman Approach Patrol", kind: "point", category: "Patrol" },
	{ key: "patrolRoute_west_strait_qrf", label: "West QRF Route", kind: "polyline", category: "Patrol" },
	{ key: "patrolRoute_east_strait_qrf", label: "East QRF Route", kind: "polyline", category: "Patrol" },
	{ key: "shallowWaters", label: "Shallow Waters", kind: "polygon", category: "Shallow Waters" },
	{ key: "veryShallowWaters", label: "Very Shallow Waters", kind: "polygon", category: "Shallow Waters" },
	{ key: "shoals", label: "Shoals", kind: "polygon", category: "Hazards" },
	{ key: "rocks", label: "Rocks", kind: "point", category: "Hazards" },
	{ key: "lane_inbound", label: "Inbound Lane", kind: "polyline", category: "Shipping Lanes" },
	{ key: "lane_outbound", label: "Outbound Lane", kind: "polyline", category: "Shipping Lanes" },
	{ key: "lane_deepWater", label: "Deep Water Route", kind: "polyline", category: "Shipping Lanes" },
];

// All known bot behaviors
export const ALL_BEHAVIORS = [
	"tanker_transit", "swarm_attack", "escort", "escort_follow", "escort_lead",
	"follow_escort_lead", "shahed_intercept", "quadcopter_intercept",
	"ground_logistics", "west_strait_qrf", "east_strait_qrf",
];

// ---------------------------------------------------------------------------
// Editor state
// ---------------------------------------------------------------------------

export type EditorMode = "select" | "draw";

export class EditorState {
	data: EditableMapData;
	activeLayerKey = "exclusionZones";
	mode: EditorMode = "select";
	selectedIndex: number | null = null;
	selectedVertexIndex: number | null = null;
	drawingVertices: [number, number][] = [];
	isDragging = false;
	getHitRadius: () => number = () => 500;

	private dragStartX = 0;
	private dragStartY = 0;
	private dragThreshold = false;

	constructor() {
		this.data = loadMapData();
	}

	get activeLayer(): LayerDef {
		return LAYERS.find((l) => l.key === this.activeLayerKey)!;
	}

	/** Get the items array for the active layer. */
	getItems(): unknown[] {
		return getLayerItems(this.data, this.activeLayerKey);
	}

	/** Get polygon/polyline vertices for an item, or null for point items. */
	getItemVertices(index: number): [number, number][] | null {
		const layer = this.activeLayer;
		const items = this.getItems();
		if (layer.kind === "polyline") return items as [number, number][];
		const item = items[index];
		if (layer.kind === "polygon") {
			if (layer.key === "exclusionZones") return (item as EditableZone).polygon;
			return item as [number, number][];
		}
		return null;
	}

	/** Get position for point items. */
	getItemPosition(index: number): [number, number] | null {
		const layer = this.activeLayer;
		const items = this.getItems();
		const item = items[index];
		if (layer.kind !== "point") return null;
		// Single-point layers (landmarks, destinations, patrol zones) are bare [x, y]
		if (layer.key.startsWith("dest_") || layer.key.startsWith("landmark_") || layer.key.startsWith("patrolZone_"))
			return item as [number, number];
		if (layer.key === "rocks") return (item as EditableRock).position;
		return (item as EditableSpawn).position;
	}

	/** Get the AreaWithRadius for the active layer (destinations and patrol zones). */
	getActiveAreaWithRadius(): AreaWithRadius | null {
		if (this.activeLayerKey === "dest_oman") return this.data.destinations.oman;
		if (this.activeLayerKey === "dest_gulf") return this.data.destinations.gulf;
		if (this.activeLayerKey === "patrolZone_strait_west") return this.data.patrolZones.strait_west;
		if (this.activeLayerKey === "patrolZone_oman_approach") return this.data.patrolZones.oman_approach;
		return null;
	}

	setMode(mode: EditorMode): void {
		if (this.mode === "draw" && mode !== "draw") {
			this.drawingVertices = [];
		}
		this.mode = mode;
		if (mode === "draw") {
			this.selectedIndex = null;
			this.selectedVertexIndex = null;
		}
	}

	setActiveLayer(key: string): void {
		this.activeLayerKey = key;
		this.selectedIndex = null;
		this.selectedVertexIndex = null;
		this.drawingVertices = [];
		this.mode = "select";
	}

	onMouseDown(wx: number, wy: number, _shift: boolean): void {
		const layer = this.activeLayer;
		const hitR = this.getHitRadius();

		if (this.mode === "draw") {
			if (layer.kind === "point") {
				this.placePoint(wx, wy);
				this.mode = "select";
			} else {
				this.drawingVertices.push([Math.round(wx), Math.round(wy)]);
			}
			return;
		}

		// Select mode: try to grab a vertex handle on the selected item
		if (this.selectedIndex !== null) {
			if (layer.kind === "point") {
				const pos = this.getItemPosition(this.selectedIndex);
				if (pos && distSq(wx, wy, pos[0], pos[1]) < hitR * hitR) {
					this.isDragging = true;
					this.dragStartX = wx;
					this.dragStartY = wy;
					this.dragThreshold = false;
					return;
				}
			} else {
				const verts = this.getItemVertices(this.selectedIndex);
				if (verts) {
					const vi = findVertex(verts, wx, wy, hitR);
					if (vi !== null) {
						this.selectedVertexIndex = vi;
						this.isDragging = true;
						this.dragStartX = wx;
						this.dragStartY = wy;
						this.dragThreshold = false;
						return;
					}
				}
			}
		}

		// Try to select an item
		const clicked = this.findItemAt(wx, wy, hitR);
		this.selectedIndex = clicked;
		this.selectedVertexIndex = null;
	}

	onMouseMove(wx: number, wy: number): void {
		if (!this.isDragging || this.selectedIndex === null) return;

		if (!this.dragThreshold) {
			const dx = wx - this.dragStartX;
			const dy = wy - this.dragStartY;
			if (dx * dx + dy * dy < 100) return;
			this.dragThreshold = true;
		}

		const layer = this.activeLayer;
		if (layer.kind === "point") {
			const pos = this.getItemPosition(this.selectedIndex);
			if (pos) {
				pos[0] = Math.round(wx);
				pos[1] = Math.round(wy);
			}
		} else if (this.selectedVertexIndex !== null) {
			const verts = this.getItemVertices(this.selectedIndex);
			if (verts) {
				verts[this.selectedVertexIndex] = [Math.round(wx), Math.round(wy)];
			}
		}
	}

	onMouseUp(): void {
		this.isDragging = false;
		this.dragThreshold = false;
	}

	onDoubleClick(wx: number, wy: number): void {
		if (this.mode === "draw") {
			this.finishDraw();
			return;
		}

		// Insert vertex on edge (polygon/polyline layers)
		const layer = this.activeLayer;
		if (this.selectedIndex !== null && (layer.kind === "polygon" || layer.kind === "polyline")) {
			const verts = this.getItemVertices(this.selectedIndex);
			if (verts) {
				const insertIdx = findEdge(verts, wx, wy, this.getHitRadius(), layer.kind === "polygon");
				if (insertIdx !== null) {
					verts.splice(insertIdx + 1, 0, [Math.round(wx), Math.round(wy)]);
					this.selectedVertexIndex = insertIdx + 1;
				}
			}
		}
	}

	finishDraw(): void {
		const layer = this.activeLayer;
		if (layer.kind === "polygon" && this.drawingVertices.length < 3) return;
		if (layer.kind === "polyline" && this.drawingVertices.length < 2) return;

		const items = this.getItems();
		if (layer.key === "exclusionZones") {
			const name = `zone_${this.data.exclusionZones.length + 1}`;
			this.data.exclusionZones.push({ name, polygon: [...this.drawingVertices], behaviors: [] });
		} else if (layer.kind === "polygon") {
			(items as [number, number][][]).push([...this.drawingVertices]);
		} else if (layer.kind === "polyline") {
			// Polyline layers are single items — replace
			const arr = items as [number, number][];
			arr.length = 0;
			arr.push(...this.drawingVertices);
		}

		this.drawingVertices = [];
		this.selectedIndex = this.getItems().length - 1;
		this.mode = "select";
	}

	cancelDraw(): void {
		this.drawingVertices = [];
	}

	deleteSelected(): void {
		if (this.selectedIndex === null) return;
		const layer = this.activeLayer;

		// For polygon/polyline: try removing just the selected vertex first
		if (this.selectedVertexIndex !== null && (layer.kind === "polygon" || layer.kind === "polyline")) {
			const verts = this.getItemVertices(this.selectedIndex);
			const minVerts = layer.kind === "polygon" ? 3 : 2;
			if (verts && verts.length > minVerts) {
				verts.splice(this.selectedVertexIndex, 1);
				this.selectedVertexIndex = null;
				return;
			}
		}

		// Delete the whole item
		const isSingleton = layer.key.startsWith("dest_") || layer.key.startsWith("landmark_") || layer.key.startsWith("patrolZone_");
		if (isSingleton) {
			return; // can't delete fixed points
		} else if (layer.kind === "polyline") {
			// Can't delete a lane — clear its points instead
			const arr = this.getItems() as [number, number][];
			arr.length = 0;
		} else {
			const items = this.getItems();
			items.splice(this.selectedIndex, 1);
		}
		this.selectedIndex = null;
		this.selectedVertexIndex = null;
	}

	selectItem(index: number): void {
		this.selectedIndex = index;
		this.selectedVertexIndex = null;
	}

	private placePoint(wx: number, wy: number): void {
		const layer = this.activeLayer;
		const pos: [number, number] = [Math.round(wx), Math.round(wy)];
		const items = this.getItems();

		const isSingleton = layer.key.startsWith("dest_") || layer.key.startsWith("landmark_") || layer.key.startsWith("patrolZone_");
		if (isSingleton) {
			// Single fixed points — move, don't add
			const pt = items[0] as [number, number];
			pt[0] = pos[0];
			pt[1] = pos[1];
			this.selectedIndex = 0;
			return;
		} else if (layer.key === "rocks") {
			this.data.rocks.push({ position: pos, radius: 80, label: "" });
		} else {
			// Spawn point
			const spawn: EditableSpawn = { position: pos, heading: 0, scatterRadius: 500, group: "", label: `spawn_${items.length + 1}` };
			(items as EditableSpawn[]).push(spawn);
		}
		this.selectedIndex = this.getItems().length - 1;
	}

	private findItemAt(wx: number, wy: number, hitR: number): number | null {
		const layer = this.activeLayer;
		const items = this.getItems();

		if (layer.kind === "point") {
			for (let i = items.length - 1; i >= 0; i--) {
				const pos = this.getItemPosition(i);
				if (pos && distSq(wx, wy, pos[0], pos[1]) < hitR * hitR) return i;
			}
			return null;
		}

		if (layer.kind === "polyline") {
			// Polylines are single items — if close to any segment, select index 0
			const verts = items as [number, number][];
			if (verts.length >= 2) {
				const edge = findEdge(verts, wx, wy, hitR, false);
				if (edge !== null) return 0;
			}
			return null;
		}

		// Polygon — point-in-polygon test
		for (let i = items.length - 1; i >= 0; i--) {
			const verts = this.getItemVertices(i);
			if (verts && pointInPolygon(wx, wy, verts)) return i;
		}
		return null;
	}
}

// ---------------------------------------------------------------------------
// Layer data accessors
// ---------------------------------------------------------------------------

function getLayerItems(data: EditableMapData, key: string): unknown[] {
	switch (key) {
		case "exclusionZones": return data.exclusionZones;
		case "spawn_iran": return data.spawns.iran;
		case "spawn_us": return data.spawns.us;
		case "spawn_tanker": return data.spawns.tanker;
		case "spawn_quadcopter": return data.spawns.quadcopter;
		case "spawn_bases": return data.spawns.bases;
		case "landmark_straitCenter": return [data.landmarks.straitCenter];
		case "dest_oman": return [data.destinations.oman.position];
		case "dest_gulf": return [data.destinations.gulf.position];
		case "patrolZone_strait_west": return [data.patrolZones.strait_west.position];
		case "patrolZone_oman_approach": return [data.patrolZones.oman_approach.position];
		case "patrolRoute_west_strait_qrf": return data.patrolRoutes.west_strait_qrf;
		case "patrolRoute_east_strait_qrf": return data.patrolRoutes.east_strait_qrf;
		case "shallowWaters": return data.shallowWaters;
		case "veryShallowWaters": return data.veryShallowWaters;
		case "shoals": return data.shoals;
		case "rocks": return data.rocks;
		case "lane_inbound": return data.lanes.inbound;
		case "lane_outbound": return data.lanes.outbound;
		case "lane_deepWater": return data.lanes.deepWaterRoute;
		default: return [];
	}
}

// ---------------------------------------------------------------------------
// Load initial data from generated module
// ---------------------------------------------------------------------------

function loadMapData(): EditableMapData {
	const copyPoly = (p: readonly (readonly [number, number])[]): [number, number][] =>
		p.map((v) => [v[0], v[1]] as [number, number]);

	const copyArea = (a: { readonly position: readonly [number, number]; readonly radius: number }): AreaWithRadius => ({
		position: [a.position[0], a.position[1]],
		radius: a.radius,
	});

	const copySpawns = (spawns: readonly MapData.SpawnPoint[]): EditableSpawn[] =>
		spawns.map((s) => ({
			position: [s.position[0], s.position[1]] as [number, number],
			heading: s.heading ?? 0,
			scatterRadius: s.scatterRadius ?? 500,
			group: s.group ?? "",
			label: s.label,
		}));

	return {
		exclusionZones: MapData.EXCLUSION_ZONES.map((z) => ({
			name: z.name,
			polygon: copyPoly(z.polygon),
			behaviors: [...z.behaviors],
		})),
		spawns: {
			iran: copySpawns(MapData.IRAN_SPAWNS),
			us: copySpawns(MapData.US_SPAWNS),
			tanker: copySpawns(MapData.TANKER_SPAWNS),
			quadcopter: copySpawns(MapData.QUADCOPTER_SPAWNS),
			bases: copySpawns(MapData.US_BASES),
		},
		landmarks: {
			straitCenter: [MapData.STRAIT_CENTER[0], MapData.STRAIT_CENTER[1]],
		},
		escortZone: {
			west: MapData.ESCORT_ZONE_WEST,
			east: MapData.ESCORT_ZONE_EAST,
		},
		patrolRoutes: {
			west_strait_qrf: [
				[MapData.QRF_PATROL_ROUTES.west_strait_qrf[0][0], MapData.QRF_PATROL_ROUTES.west_strait_qrf[0][1]],
				[MapData.QRF_PATROL_ROUTES.west_strait_qrf[1][0], MapData.QRF_PATROL_ROUTES.west_strait_qrf[1][1]],
			],
			east_strait_qrf: [
				[MapData.QRF_PATROL_ROUTES.east_strait_qrf[0][0], MapData.QRF_PATROL_ROUTES.east_strait_qrf[0][1]],
				[MapData.QRF_PATROL_ROUTES.east_strait_qrf[1][0], MapData.QRF_PATROL_ROUTES.east_strait_qrf[1][1]],
			],
		},
		patrolZones: {
			strait_west: copyArea(MapData.PATROL_ZONES.strait_west),
			oman_approach: copyArea(MapData.PATROL_ZONES.oman_approach),
		},
		destinations: {
			oman: copyArea(MapData.OMAN_DESTINATION),
			gulf: copyArea(MapData.GULF_DESTINATION),
		},
		shallowWaters: MapData.SHALLOW_WATERS.map((p) => copyPoly(p)),
		veryShallowWaters: MapData.VERY_SHALLOW_WATERS.map((p) => copyPoly(p)),
		shoals: MapData.SHOALS.map((p) => copyPoly(p)),
		rocks: MapData.ROCKS.map((r) => ({
			position: [r.position[0], r.position[1]] as [number, number],
			radius: r.radius,
			label: r.label ?? "",
		})),
		lanes: {
			inbound: copyPoly(MapData.LANE_INBOUND),
			outbound: copyPoly(MapData.LANE_OUTBOUND),
			deepWaterRoute: copyPoly(MapData.DEEP_WATER_ROUTE),
		},
	};
}

// Expose for convenience
{ getLayerItems };

// ---------------------------------------------------------------------------
// Geometry utilities
// ---------------------------------------------------------------------------

function distSq(x1: number, y1: number, x2: number, y2: number): number {
	const dx = x2 - x1;
	const dy = y2 - y1;
	return dx * dx + dy * dy;
}

function findVertex(
	polygon: [number, number][], wx: number, wy: number, hitRadius: number,
): number | null {
	const r2 = hitRadius * hitRadius;
	for (let i = 0; i < polygon.length; i++) {
		if (distSq(wx, wy, polygon[i][0], polygon[i][1]) < r2) return i;
	}
	return null;
}

function findEdge(
	verts: [number, number][], wx: number, wy: number, hitRadius: number, closed: boolean,
): number | null {
	let bestDist = hitRadius;
	let bestIdx: number | null = null;
	const len = closed ? verts.length : verts.length - 1;
	for (let i = 0; i < len; i++) {
		const a = verts[i];
		const b = verts[(i + 1) % verts.length];
		const dist = pointToSegmentDist(wx, wy, a[0], a[1], b[0], b[1]);
		if (dist < bestDist) {
			bestDist = dist;
			bestIdx = i;
		}
	}
	return bestIdx;
}

function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i][0], yi = poly[i][1];
		const xj = poly[j][0], yj = poly[j][1];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

function pointToSegmentDist(
	px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
	const dx = bx - ax;
	const dy = by - ay;
	const lenSq = dx * dx + dy * dy;
	if (lenSq === 0) return Math.hypot(px - ax, py - ay);
	let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
