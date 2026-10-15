/**
 * Three.js map renderer — sea, terrain, rocks and gameplay overlays.
 *
 * The sea is one large lit plane (water-material.ts); land is a single
 * displaced terrain mesh following the gameplay heightmap, clipped to the
 * coastline polygons per pixel (terrain-material.ts). Both are built once
 * in world coordinates (X = east, Y = up, Z = south); the camera handles
 * projection.
 */

import * as THREE from "three/webgpu";
import { getCoastField } from "../map/coast-field";
import {
	DEEP_WATER_ROUTE,
	EXCLUSION_ZONES,
	IRAN_SPAWNS,
	LANE_INBOUND,
	LANE_OUTBOUND,
	MAP,
	ROCKS,
	SHOALS,
	TANKER_SPAWNS,
	US_BASES,
	US_SPAWNS,
} from "../map/data";
import { HEIGHTMAP_CELL_SIZE } from "../map/heightmap";
import { HEIGHTMAP_MAX_ELEVATION } from "../map/heightmap-data";
import { COLORS } from "./colors";
import {
	createBathymetryTexture,
	createCoastTexture,
	createWaveTexture,
} from "./map-textures";
import { createTerrainMaterial } from "./terrain-material";
import { terrainSurfaceHeight } from "./terrain-surface";
import { createWaterMaterial } from "./water-material";
import { mulberry32 } from "./water-textures";

// ---------------------------------------------------------------------------
// Map layer visibility configuration
// ---------------------------------------------------------------------------

export interface MapLayers {
	showDepthZones: boolean;
	showShippingLanes: boolean;
	showHazards: boolean;
	showSpawnPoints: boolean;
	showTerrain: boolean;
	showGrid: boolean;
	showExclusionZones: boolean;
	gridSize: number;
}

export const DEFAULT_LAYERS: MapLayers = {
	showDepthZones: true,
	showShippingLanes: true,
	showHazards: true,
	showSpawnPoints: false,
	showTerrain: true,
	showGrid: false,
	showExclusionZones: false,
	gridSize: 1000,
};

// ---------------------------------------------------------------------------
// Geometry constants
// ---------------------------------------------------------------------------

/** Overlays float just above the sea; terrain occludes them on land. */
const Y_OVERLAYS = 0.3;
const Y_MARKERS = 0.35;

/** How far sea and land extend past the playable map (for perspective views). */
const WORLD_MARGIN = 60000;
const MARGIN_STEP = 2000;
/** Terrain vertex spacing inside the map: two per heightmap cell. */
const TERRAIN_STEP = HEIGHTMAP_CELL_SIZE / 2;
/**
 * Relief is gameplay-scaled (≤300 units over a 113 km map), which would
 * read as flat; shading normals exaggerate slopes like the old hillshade did.
 */
const NORMAL_EXAGGERATION = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect line-segment vertex pairs for a closed polygon border. */
function polygonBorderSegments(
	poly: readonly [number, number][],
	y: number,
): THREE.Vector3[] {
	const pts: THREE.Vector3[] = [];
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		pts.push(new THREE.Vector3(a[0], y, a[1]));
		pts.push(new THREE.Vector3(b[0], y, b[1]));
	}
	return pts;
}

/** Remap ShapeGeometry from XY plane to XZ: (gx, gy, 0) → (gx, 0, gy). */
function shapeGeoToXZ(geo: THREE.BufferGeometry): void {
	const pos = geo.getAttribute("position") as THREE.BufferAttribute;
	for (let i = 0; i < pos.count; i++) {
		const y = pos.getY(i);
		pos.setY(i, 0);
		pos.setZ(i, y);
	}
	pos.needsUpdate = true;
}

function polygonToShape(poly: readonly [number, number][]): THREE.Shape {
	const shape = new THREE.Shape();
	shape.moveTo(poly[0][0], poly[0][1]);
	for (let i = 1; i < poly.length; i++) {
		shape.lineTo(poly[i][0], poly[i][1]);
	}
	return shape;
}

/** Vertex coordinates along one axis: fine inside the map, coarse in the margin. */
function axisTicks(length: number): number[] {
	const ticks: number[] = [];
	for (let v = -WORLD_MARGIN; v < 0; v += MARGIN_STEP) ticks.push(v);
	for (let v = 0; v < length; v += TERRAIN_STEP) ticks.push(v);
	ticks.push(length);
	for (
		let v = length + MARGIN_STEP;
		v <= length + WORLD_MARGIN;
		v += MARGIN_STEP
	)
		ticks.push(v);
	return ticks;
}

function createTerrainGeometry(): THREE.BufferGeometry {
	const xs = axisTicks(MAP.width);
	const zs = axisTicks(MAP.height);
	const cols = xs.length;
	const rows = zs.length;

	const heights = new Float32Array(cols * rows);
	for (let r = 0; r < rows; r++) {
		const z = Math.max(0, Math.min(MAP.height, zs[r]));
		for (let c = 0; c < cols; c++) {
			const x = Math.max(0, Math.min(MAP.width, xs[c]));
			heights[r * cols + c] = terrainSurfaceHeight(x, z);
		}
	}

	const positions = new Float32Array(cols * rows * 3);
	const normals = new Float32Array(cols * rows * 3);
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const i = r * cols + c;
			positions[i * 3] = xs[c];
			positions[i * 3 + 1] = heights[i];
			positions[i * 3 + 2] = zs[r];

			const c0 = Math.max(0, c - 1);
			const c1 = Math.min(cols - 1, c + 1);
			const r0 = Math.max(0, r - 1);
			const r1 = Math.min(rows - 1, r + 1);
			const dhdx =
				(heights[r * cols + c1] - heights[r * cols + c0]) / (xs[c1] - xs[c0]);
			const dhdz =
				(heights[r1 * cols + c] - heights[r0 * cols + c]) / (zs[r1] - zs[r0]);
			const nx = -dhdx * NORMAL_EXAGGERATION;
			const nz = -dhdz * NORMAL_EXAGGERATION;
			const length = Math.hypot(nx, 1, nz);
			normals[i * 3] = nx / length;
			normals[i * 3 + 1] = 1 / length;
			normals[i * 3 + 2] = nz / length;
		}
	}

	const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
	let k = 0;
	for (let r = 0; r < rows - 1; r++) {
		for (let c = 0; c < cols - 1; c++) {
			const a = r * cols + c;
			const b = a + 1;
			const d = a + cols;
			const e = d + 1;
			// Counter-clockwise seen from above (+Y), so faces point up.
			indices.set([a, d, b, b, d, e], k);
			k += 6;
		}
	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
	geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
	geometry.setIndex(new THREE.BufferAttribute(indices, 1));
	geometry.computeBoundingSphere();
	return geometry;
}

/** A lumpy, half-submerged boulder cluster. */
function createRockGeometry(
	radius: number,
	seed: number,
): THREE.BufferGeometry {
	const random = mulberry32(seed);
	const geometry = new THREE.IcosahedronGeometry(radius, 2);
	const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
	const offsets = new Map<string, number>();
	for (let i = 0; i < pos.count; i++) {
		// Shared corners must move together or the surface tears.
		const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
		let scale = offsets.get(key);
		if (scale === undefined) {
			scale = 0.7 + random() * 0.5;
			offsets.set(key, scale);
		}
		pos.setXYZ(
			i,
			pos.getX(i) * scale,
			pos.getY(i) * scale * 0.4 + radius * 0.05,
			pos.getZ(i) * scale,
		);
	}
	geometry.computeVertexNormals();
	return geometry;
}

// ---------------------------------------------------------------------------
// ThreeMapRenderer
// ---------------------------------------------------------------------------

export class ThreeMapRenderer {
	/** Add this group to the Three.js scene. */
	readonly root = new THREE.Group();

	private readonly depthZones: { value: number };
	private readonly relief: { value: number };
	private hazardGroup!: THREE.Group;
	private laneGroup!: THREE.Group;
	private gridGroup!: THREE.Group;
	private spawnGroup!: THREE.Group;
	private exclusionZoneGroup!: THREE.Group;

	private geometries: THREE.BufferGeometry[] = [];
	private materials: THREE.Material[] = [];
	private textures: THREE.Texture[] = [];
	private laneGeometries: THREE.BufferGeometry[] = [];
	private laneMaterials: THREE.Material[] = [];

	/**
	 * @param reflections Pre-filtered sky (Environment.reflections) for the
	 *   sea; without it the sea uses the scene's dimmer diffuse environment.
	 */
	constructor(layers: MapLayers = DEFAULT_LAYERS, reflections?: THREE.Texture) {
		const field = getCoastField();
		const mapSize = new THREE.Vector2(
			field.grid.width * field.grid.cellSize,
			field.grid.height * field.grid.cellSize,
		);
		const coastTexture = this.tex(createCoastTexture(field));
		const waveTexture = this.tex(createWaveTexture());

		const water = createWaterMaterial({
			coastTexture,
			bathymetryTexture: this.tex(createBathymetryTexture()),
			waveTexture,
			mapSize,
		});
		this.depthZones = water.depthZones;
		if (reflections) {
			water.material.envMap = reflections;
			water.material.envMapIntensity = 0.85;
		}
		this.buildWater(water.material);

		const terrain = createTerrainMaterial({
			coastTexture,
			noiseTexture: waveTexture,
			mapSize,
			maxElevation: HEIGHTMAP_MAX_ELEVATION,
		});
		this.relief = terrain.relief;
		this.buildTerrain(terrain.material);
		this.buildRocks();

		this.hazardGroup = this.buildHazards();
		this.laneGroup = this.buildLanes();
		this.gridGroup = this.buildGrid(layers.gridSize);
		this.spawnGroup = this.buildSpawns();
		this.buildBases(this.spawnGroup);
		this.exclusionZoneGroup = this.buildExclusionZones();

		this.setLayers(layers);
	}

	/** Rebuild lane geometry from external (editor) data. */
	updateLanes(lanes: {
		inbound: readonly [number, number][];
		outbound: readonly [number, number][];
		deepWaterRoute: readonly [number, number][];
	}): void {
		const wasVisible = this.laneGroup.visible;
		this.root.remove(this.laneGroup);
		this.disposeLaneGroup();
		this.laneGroup = this.buildLanesFrom(
			lanes.inbound,
			lanes.outbound,
			lanes.deepWaterRoute,
		);
		this.laneGroup.visible = wasVisible;
	}

	setLayers(layers: MapLayers): void {
		this.depthZones.value = layers.showDepthZones ? 1 : 0;
		this.relief.value = layers.showTerrain ? 1 : 0;
		this.hazardGroup.visible = layers.showHazards;
		this.laneGroup.visible = layers.showShippingLanes;
		this.gridGroup.visible = layers.showGrid;
		this.spawnGroup.visible = layers.showSpawnPoints;
		this.exclusionZoneGroup.visible = layers.showExclusionZones;
	}

	dispose(): void {
		for (const g of this.geometries) g.dispose();
		for (const m of this.materials) m.dispose();
		for (const t of this.textures) t.dispose();
		this.disposeLaneGroup();
	}

	// --- Resource tracking ---

	private geo<T extends THREE.BufferGeometry>(g: T): T {
		this.geometries.push(g);
		return g;
	}
	private mat<T extends THREE.Material>(m: T): T {
		this.materials.push(m);
		return m;
	}
	private tex<T extends THREE.Texture>(t: T): T {
		this.textures.push(t);
		return t;
	}

	// --- Layer builders ---

	private buildWater(material: THREE.Material): void {
		const g = this.geo(
			new THREE.PlaneGeometry(
				MAP.width + WORLD_MARGIN * 2,
				MAP.height + WORLD_MARGIN * 2,
			),
		);
		g.rotateX(-Math.PI / 2);
		const mesh = new THREE.Mesh(g, this.mat(material));
		mesh.position.set(MAP.width / 2, 0, MAP.height / 2);
		mesh.receiveShadow = true;
		this.root.add(mesh);
	}

	private buildTerrain(material: THREE.Material): void {
		const mesh = new THREE.Mesh(
			this.geo(createTerrainGeometry()),
			this.mat(material),
		);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		this.root.add(mesh);
	}

	private buildRocks(): void {
		const material = this.mat(
			new THREE.MeshStandardNodeMaterial({ color: 0x3a3430, roughness: 0.92 }),
		);
		ROCKS.forEach((rock, i) => {
			const mesh = new THREE.Mesh(
				this.geo(createRockGeometry(rock.radius * 0.8, 0x70c4 + i)),
				material,
			);
			mesh.position.set(rock.position[0], 0, rock.position[1]);
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			this.root.add(mesh);
		});
	}

	/** Chart outlines of shoals and rocks (the sea surface shows them regardless). */
	private buildHazards(): THREE.Group {
		const group = new THREE.Group();
		const material = this.mat(
			new THREE.LineBasicMaterial({
				color: COLORS.shoalBorder,
				transparent: true,
				opacity: 0.55,
			}),
		);

		const borderPts: THREE.Vector3[] = [];
		for (const shoal of SHOALS) {
			borderPts.push(...polygonBorderSegments(shoal, Y_OVERLAYS));
		}
		for (const rock of ROCKS) {
			const ring: [number, number][] = Array.from({ length: 24 }, (_, i) => {
				const angle = (i / 24) * Math.PI * 2;
				return [
					rock.position[0] + Math.cos(angle) * rock.radius * 1.6,
					rock.position[1] + Math.sin(angle) * rock.radius * 1.6,
				];
			});
			borderPts.push(...polygonBorderSegments(ring, Y_OVERLAYS));
		}
		if (borderPts.length > 0) {
			const g = this.geo(new THREE.BufferGeometry().setFromPoints(borderPts));
			group.add(new THREE.LineSegments(g, material));
		}

		this.root.add(group);
		return group;
	}

	private buildLanes(): THREE.Group {
		return this.buildLanesFrom(LANE_INBOUND, LANE_OUTBOUND, DEEP_WATER_ROUTE);
	}

	private buildLanesFrom(
		inbound: readonly [number, number][],
		outbound: readonly [number, number][],
		deepWaterRoute: readonly [number, number][],
	): THREE.Group {
		const group = new THREE.Group();

		const addLane = (
			line: readonly [number, number][],
			color: number,
			dashSize: number,
			gapSize: number,
		) => {
			if (line.length < 2) return;
			const points = line.map(([x, y]) => new THREE.Vector3(x, Y_OVERLAYS, y));
			const g = new THREE.BufferGeometry().setFromPoints(points);
			this.laneGeometries.push(g);
			const m = new THREE.LineDashedMaterial({
				color,
				dashSize,
				gapSize,
				transparent: true,
				opacity: 0.9,
			});
			this.laneMaterials.push(m);
			const line3 = new THREE.Line(g, m);
			line3.computeLineDistances();
			group.add(line3);
		};

		addLane(deepWaterRoute, COLORS.deepWaterRoute, 800, 500);
		addLane(inbound, COLORS.laneInbound, 600, 400);
		addLane(outbound, COLORS.laneOutbound, 600, 400);

		this.root.add(group);
		return group;
	}

	private disposeLaneGroup(): void {
		for (const g of this.laneGeometries) g.dispose();
		for (const m of this.laneMaterials) m.dispose();
		this.laneGeometries = [];
		this.laneMaterials = [];
	}

	private buildGrid(gridSize: number): THREE.Group {
		const group = new THREE.Group();

		const points: THREE.Vector3[] = [];
		for (let wx = 0; wx <= MAP.width; wx += gridSize) {
			points.push(new THREE.Vector3(wx, Y_OVERLAYS, 0));
			points.push(new THREE.Vector3(wx, Y_OVERLAYS, MAP.height));
		}
		for (let wy = 0; wy <= MAP.height; wy += gridSize) {
			points.push(new THREE.Vector3(0, Y_OVERLAYS, wy));
			points.push(new THREE.Vector3(MAP.width, Y_OVERLAYS, wy));
		}

		if (points.length > 0) {
			const g = this.geo(new THREE.BufferGeometry().setFromPoints(points));
			const m = this.mat(
				new THREE.LineBasicMaterial({
					color: COLORS.grid,
					transparent: true,
					opacity: 0.3,
				}),
			);
			group.add(new THREE.LineSegments(g, m));
		}

		this.root.add(group);
		return group;
	}

	private buildBases(group: THREE.Group): void {
		const m = this.mat(
			new THREE.MeshBasicMaterial({
				color: COLORS.spawnUS,
				side: THREE.DoubleSide,
				transparent: true,
				opacity: 0.5,
				depthWrite: false,
			}),
		);

		for (const base of US_BASES) {
			const g = this.geo(new THREE.PlaneGeometry(400, 400));
			shapeGeoToXZ(g);
			const mesh = new THREE.Mesh(g, m);
			mesh.position.set(
				base.position[0],
				terrainSurfaceHeight(base.position[0], base.position[1]) + Y_MARKERS,
				base.position[1],
			);
			mesh.renderOrder = 6;
			group.add(mesh);
		}
	}

	private buildSpawns(): THREE.Group {
		const group = new THREE.Group();

		const markerMaterial = (color: number) =>
			this.mat(
				new THREE.MeshBasicMaterial({
					color,
					side: THREE.DoubleSide,
					transparent: true,
					opacity: 0.7,
					depthWrite: false,
				}),
			);

		const iranMat = markerMaterial(COLORS.spawnIran);
		for (const sp of IRAN_SPAWNS) {
			const g = this.geo(new THREE.CircleGeometry(300, 24));
			shapeGeoToXZ(g);
			const mesh = new THREE.Mesh(g, iranMat);
			mesh.position.set(sp.position[0], Y_MARKERS, sp.position[1]);
			group.add(mesh);
		}

		const usMat = markerMaterial(COLORS.spawnUS);
		for (const sp of US_SPAWNS) {
			const g = this.geo(new THREE.PlaneGeometry(300, 300));
			shapeGeoToXZ(g);
			const mesh = new THREE.Mesh(g, usMat);
			mesh.position.set(sp.position[0], Y_MARKERS, sp.position[1]);
			group.add(mesh);
		}

		const tankerMat = markerMaterial(COLORS.spawnTanker);
		for (const sp of TANKER_SPAWNS) {
			const size = 300;
			const shape = new THREE.Shape();
			shape.moveTo(0, -size);
			shape.lineTo(size, 0);
			shape.lineTo(0, size);
			shape.lineTo(-size, 0);
			const g = this.geo(new THREE.ShapeGeometry(shape));
			shapeGeoToXZ(g);
			const mesh = new THREE.Mesh(g, tankerMat);
			mesh.position.set(sp.position[0], Y_MARKERS, sp.position[1]);
			group.add(mesh);
		}

		this.root.add(group);
		return group;
	}

	private buildExclusionZones(): THREE.Group {
		const group = new THREE.Group();

		const borderMat = this.mat(
			new THREE.LineBasicMaterial({
				color: 0xff2200,
				transparent: true,
				opacity: 0.6,
			}),
		);
		const fillMat = this.mat(
			new THREE.MeshBasicMaterial({
				color: 0xff2200,
				transparent: true,
				opacity: 0.15,
				side: THREE.DoubleSide,
				depthWrite: false,
			}),
		);

		for (const zone of EXCLUSION_ZONES) {
			const poly = zone.polygon.map((p) => [p[0], p[1]] as [number, number]);
			const g = this.geo(new THREE.ShapeGeometry(polygonToShape(poly)));
			shapeGeoToXZ(g);
			const fill = new THREE.Mesh(g, fillMat);
			fill.position.y = Y_OVERLAYS;
			group.add(fill);

			const pts = zone.polygon.map(
				(p) => new THREE.Vector3(p[0], Y_OVERLAYS, p[1]),
			);
			pts.push(pts[0].clone());
			const lineGeo = this.geo(new THREE.BufferGeometry().setFromPoints(pts));
			group.add(new THREE.Line(lineGeo, borderMat));
		}

		this.root.add(group);
		return group;
	}
}
