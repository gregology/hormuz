/**
 * Three.js map renderer — water, terrain, coastlines, overlays.
 *
 * All geometry is in game world coordinates (X = east, Z = south in Three.js).
 * The isometric camera handles projection — no per-frame geometry updates needed.
 */

import * as THREE from "three";
import { ARABIAN_COAST_POLYS, IRAN_COAST_POLYS } from "../map/coastlines";
import {
	DEEP_WATER_ROUTE,
	EXCLUSION_ZONES,
	IRAN_SPAWNS,
	ISLAND_POLYGONS,
	LANE_INBOUND,
	LANE_OUTBOUND,
	MAP,
	ROCKS,
	SHALLOW_WATERS,
	SHOALS,
	TANKER_SPAWNS,
	US_BASES,
	US_SPAWNS,
	VERY_SHALLOW_WATERS,
} from "../map/data";
import {
	HEIGHTMAP_CELL_SIZE,
	HEIGHTMAP_HEIGHT,
	HEIGHTMAP_WIDTH,
	createHeightmapPixels,
} from "../map/heightmap";
import { HEIGHTMAP_MAX_ELEVATION } from "../map/heightmap-data";
import { COLORS } from "./colors";

import mapVert from "./shaders/map.vert?raw";
import terrainFrag from "./shaders/terrain.frag?raw";
import waterFrag from "./shaders/water.frag?raw";

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
// Y-layer offsets (higher = closer to isometric camera = draws on top)
// ---------------------------------------------------------------------------

const Y_WATER = 0;
const Y_DEPTH_ZONES = 0.05;
const Y_LAND = 0.1;
const Y_STENCIL = 0.15;
const Y_TERRAIN = 0.2;
const Y_OVERLAYS = 0.3;
const Y_MARKERS = 0.35;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function polygonToShape(poly: readonly [number, number][]): THREE.Shape {
	const shape = new THREE.Shape();
	shape.moveTo(poly[0][0], poly[0][1]);
	for (let i = 1; i < poly.length; i++) {
		shape.lineTo(poly[i][0], poly[i][1]);
	}
	return shape;
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

/** Quad BufferGeometry in XZ covering the full heightmap extent. */
function createMapPlaneGeo(): THREE.BufferGeometry {
	const w = HEIGHTMAP_WIDTH * HEIGHTMAP_CELL_SIZE;
	const h = HEIGHTMAP_HEIGHT * HEIGHTMAP_CELL_SIZE;
	const geo = new THREE.BufferGeometry();
	geo.setAttribute(
		"position",
		new THREE.Float32BufferAttribute([0, 0, 0, w, 0, 0, w, 0, h, 0, 0, h], 3),
	);
	geo.setAttribute(
		"uv",
		new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2),
	);
	// CCW winding for upward-facing normals
	geo.setIndex([0, 3, 1, 1, 3, 2]);
	return geo;
}

function createHeightmapTexture(): THREE.DataTexture {
	const { data, width, height } = createHeightmapPixels();
	const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
	tex.magFilter = THREE.LinearFilter;
	tex.minFilter = THREE.LinearFilter;
	tex.needsUpdate = true;
	return tex;
}

/** Collect line-segment vertex pairs for a closed polygon border. */
function polygonBorderSegments(poly: readonly [number, number][], y: number): THREE.Vector3[] {
	const pts: THREE.Vector3[] = [];
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % poly.length];
		pts.push(new THREE.Vector3(a[0], y, a[1]));
		pts.push(new THREE.Vector3(b[0], y, b[1]));
	}
	return pts;
}

function createFilledShapes(
	polys: readonly (readonly [number, number][])[],
	color: number,
	alpha: number,
	y: number,
	depthWrite: boolean,
): { mesh: THREE.Mesh; geo: THREE.BufferGeometry; mat: THREE.Material } {
	const shapes = polys.filter((p) => p.length >= 3).map(polygonToShape);
	const geo = new THREE.ShapeGeometry(shapes);
	shapeGeoToXZ(geo);
	const mat = new THREE.MeshBasicMaterial({
		color,
		transparent: alpha < 1,
		opacity: alpha,
		side: THREE.DoubleSide,
		depthWrite,
	});
	const mesh = new THREE.Mesh(geo, mat);
	mesh.position.y = y;
	return { mesh, geo, mat };
}

// ---------------------------------------------------------------------------
// ThreeMapRenderer
// ---------------------------------------------------------------------------

export class ThreeMapRenderer {
	/** Add this group to the Three.js scene. */
	readonly root = new THREE.Group();

	private waterUniforms = {
		uTime: { value: 0 },
		uZoom: { value: 1 },
	};

	private depthZoneGroup!: THREE.Group;
	private terrainMesh!: THREE.Mesh;
	private hazardGroup!: THREE.Group;
	private laneGroup!: THREE.Group;
	private gridGroup!: THREE.Group;
	private spawnGroup!: THREE.Group;
	private exclusionZoneGroup!: THREE.Group;

	private geometries: THREE.BufferGeometry[] = [];
	private materials: THREE.Material[] = [];
	private textures: THREE.Texture[] = [];

	constructor(layers: MapLayers = DEFAULT_LAYERS) {
		this.buildWater();
		this.depthZoneGroup = this.buildDepthZones();
		this.buildLandFills();
		this.terrainMesh = this.buildTerrain();
		this.buildBorders();
		this.hazardGroup = this.buildHazards();
		this.laneGroup = this.buildLanes();
		this.gridGroup = this.buildGrid(layers.gridSize);
		this.spawnGroup = this.buildSpawns();
		this.buildBases(this.spawnGroup);
		this.exclusionZoneGroup = this.buildExclusionZones();

		this.setLayers(layers);
	}

	update(time: number, zoom: number): void {
		this.waterUniforms.uTime.value = time;
		this.waterUniforms.uZoom.value = zoom;
	}

	setLayers(layers: MapLayers): void {
		this.depthZoneGroup.visible = layers.showDepthZones;
		this.terrainMesh.visible = layers.showTerrain;
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

	private buildWater(): void {
		const g = this.geo(createMapPlaneGeo());
		const m = this.mat(
			new THREE.ShaderMaterial({
				glslVersion: THREE.GLSL3,
				vertexShader: mapVert,
				fragmentShader: waterFrag,
				uniforms: this.waterUniforms,
				side: THREE.DoubleSide,
			}),
		);
		const mesh = new THREE.Mesh(g, m);
		mesh.position.y = Y_WATER;
		mesh.renderOrder = 0;
		this.root.add(mesh);
	}

	private buildDepthZones(): THREE.Group {
		const group = new THREE.Group();
		group.renderOrder = 1;

		if (SHALLOW_WATERS.length > 0) {
			const { mesh, geo, mat } = createFilledShapes(
				SHALLOW_WATERS,
				COLORS.shallowWater,
				0.4,
				Y_DEPTH_ZONES,
				false,
			);
			this.geo(geo);
			this.mat(mat);
			mesh.renderOrder = 1;
			group.add(mesh);
		}

		if (VERY_SHALLOW_WATERS.length > 0) {
			const { mesh, geo, mat } = createFilledShapes(
				VERY_SHALLOW_WATERS,
				COLORS.veryShallowWater,
				0.5,
				Y_DEPTH_ZONES + 0.01,
				false,
			);
			this.geo(geo);
			this.mat(mat);
			mesh.renderOrder = 1;
			group.add(mesh);
		}

		this.root.add(group);
		return group;
	}

	private buildLandFills(): void {
		const coastPolys = [...IRAN_COAST_POLYS, ...ARABIAN_COAST_POLYS];
		if (coastPolys.length > 0) {
			const { mesh, geo, mat } = createFilledShapes(
				coastPolys,
				COLORS.land,
				1,
				Y_LAND,
				true,
			);
			this.geo(geo);
			this.mat(mat);
			mesh.renderOrder = 2;
			this.root.add(mesh);
		}

		const islandPolys = ISLAND_POLYGONS.map((i) => i.polygon);
		if (islandPolys.length > 0) {
			const { mesh, geo, mat } = createFilledShapes(
				islandPolys,
				COLORS.island,
				1,
				Y_LAND + 0.01,
				true,
			);
			this.geo(geo);
			this.mat(mat);
			mesh.renderOrder = 2;
			this.root.add(mesh);
		}
	}

	private buildTerrain(): THREE.Mesh {
		// Stencil write: mark coastline pixels so terrain only renders on land
		const allLandPolys = [
			...IRAN_COAST_POLYS,
			...ARABIAN_COAST_POLYS,
			...ISLAND_POLYGONS.map((i) => i.polygon),
		];
		const stencilShapes = allLandPolys
			.filter((p) => p.length >= 3)
			.map(polygonToShape);
		const stencilGeo = this.geo(new THREE.ShapeGeometry(stencilShapes));
		shapeGeoToXZ(stencilGeo);
		const stencilMat = this.mat(
			new THREE.MeshBasicMaterial({
				colorWrite: false,
				depthWrite: false,
				stencilWrite: true,
				stencilRef: 1,
				stencilFunc: THREE.AlwaysStencilFunc,
				stencilFail: THREE.KeepStencilOp,
				stencilZFail: THREE.KeepStencilOp,
				stencilZPass: THREE.ReplaceStencilOp,
				side: THREE.DoubleSide,
			}),
		);
		const stencilMesh = new THREE.Mesh(stencilGeo, stencilMat);
		stencilMesh.position.y = Y_STENCIL;
		stencilMesh.renderOrder = 3;
		this.root.add(stencilMesh);

		// Terrain quad — heightmap shader, stencil-tested to coastlines
		const heightmapTex = this.tex(createHeightmapTexture());
		const terrainGeo = this.geo(createMapPlaneGeo());
		const terrainMat = this.mat(
			new THREE.ShaderMaterial({
				glslVersion: THREE.GLSL3,
				vertexShader: mapVert,
				fragmentShader: terrainFrag,
				uniforms: {
					uTexture: { value: heightmapTex },
					uGradientScale: { value: 3.0 },
					uMaxElevation: { value: HEIGHTMAP_MAX_ELEVATION },
				},
				transparent: true,
				side: THREE.DoubleSide,
				depthWrite: false,
				stencilWrite: true,
				stencilFunc: THREE.EqualStencilFunc,
				stencilRef: 1,
				stencilFail: THREE.KeepStencilOp,
				stencilZFail: THREE.KeepStencilOp,
				stencilZPass: THREE.KeepStencilOp,
			}),
		);
		const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
		terrainMesh.position.y = Y_TERRAIN;
		terrainMesh.renderOrder = 4;
		this.root.add(terrainMesh);

		return terrainMesh;
	}

	private buildBorders(): void {
		const coastPts: THREE.Vector3[] = [];
		for (const poly of IRAN_COAST_POLYS) {
			coastPts.push(...polygonBorderSegments(poly, Y_OVERLAYS));
		}
		for (const poly of ARABIAN_COAST_POLYS) {
			coastPts.push(...polygonBorderSegments(poly, Y_OVERLAYS));
		}
		if (coastPts.length > 0) {
			const g = this.geo(new THREE.BufferGeometry().setFromPoints(coastPts));
			const m = this.mat(
				new THREE.LineBasicMaterial({ color: COLORS.landBorder }),
			);
			const lines = new THREE.LineSegments(g, m);
			lines.renderOrder = 5;
			this.root.add(lines);
		}

		const islandPts: THREE.Vector3[] = [];
		for (const island of ISLAND_POLYGONS) {
			islandPts.push(...polygonBorderSegments(island.polygon, Y_OVERLAYS));
		}
		if (islandPts.length > 0) {
			const g = this.geo(new THREE.BufferGeometry().setFromPoints(islandPts));
			const m = this.mat(
				new THREE.LineBasicMaterial({ color: COLORS.islandBorder }),
			);
			const lines = new THREE.LineSegments(g, m);
			lines.renderOrder = 5;
			this.root.add(lines);
		}
	}

	private buildHazards(): THREE.Group {
		const group = new THREE.Group();
		group.renderOrder = 5;

		if (SHOALS.length > 0) {
			const { mesh, geo, mat } = createFilledShapes(
				SHOALS,
				COLORS.shoal,
				0.6,
				Y_OVERLAYS,
				false,
			);
			this.geo(geo);
			this.mat(mat);
			group.add(mesh);

			const borderPts: THREE.Vector3[] = [];
			for (const shoal of SHOALS) {
				borderPts.push(...polygonBorderSegments(shoal, Y_OVERLAYS + 0.01));
			}
			const bg = this.geo(new THREE.BufferGeometry().setFromPoints(borderPts));
			const bm = this.mat(
				new THREE.LineBasicMaterial({ color: COLORS.shoalBorder }),
			);
			group.add(new THREE.LineSegments(bg, bm));
		}

		const rockMat = this.mat(
			new THREE.MeshBasicMaterial({
				color: COLORS.rock,
				side: THREE.DoubleSide,
				transparent: true,
				opacity: 0.8,
				depthWrite: false,
			}),
		);
		for (const rock of ROCKS) {
			const g = this.geo(new THREE.CircleGeometry(rock.radius, 24));
			shapeGeoToXZ(g);
			const mesh = new THREE.Mesh(g, rockMat);
			mesh.position.set(rock.position[0], Y_OVERLAYS, rock.position[1]);
			group.add(mesh);
		}

		this.root.add(group);
		return group;
	}

	private buildLanes(): THREE.Group {
		const group = new THREE.Group();
		group.renderOrder = 5;

		const addLane = (
			line: readonly [number, number][],
			color: number,
			dashSize: number,
			gapSize: number,
		) => {
			if (line.length < 2) return;
			const points = line.map(([x, y]) => new THREE.Vector3(x, Y_OVERLAYS, y));
			const g = this.geo(new THREE.BufferGeometry().setFromPoints(points));
			const m = this.mat(
				new THREE.LineDashedMaterial({
					color,
					dashSize,
					gapSize,
					transparent: true,
					opacity: 0.6,
				}),
			);
			const line3 = new THREE.Line(g, m);
			line3.computeLineDistances();
			group.add(line3);
		};

		addLane(DEEP_WATER_ROUTE, COLORS.deepWaterRoute, 800, 500);
		addLane(LANE_INBOUND, COLORS.laneInbound, 600, 400);
		addLane(LANE_OUTBOUND, COLORS.laneOutbound, 600, 400);

		this.root.add(group);
		return group;
	}

	private buildGrid(gridSize: number): THREE.Group {
		const group = new THREE.Group();
		group.renderOrder = 5;

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
			mesh.position.set(base.position[0], Y_MARKERS, base.position[1]);
			mesh.renderOrder = 6;
			group.add(mesh);
		}
	}

	private buildSpawns(): THREE.Group {
		const group = new THREE.Group();
		group.renderOrder = 6;

		const iranMat = this.mat(
			new THREE.MeshBasicMaterial({
				color: COLORS.spawnIran,
				side: THREE.DoubleSide,
				transparent: true,
				opacity: 0.7,
				depthWrite: false,
			}),
		);
		for (const sp of IRAN_SPAWNS) {
			const g = this.geo(new THREE.CircleGeometry(300, 24));
			shapeGeoToXZ(g);
			const mesh = new THREE.Mesh(g, iranMat);
			mesh.position.set(sp.position[0], Y_MARKERS, sp.position[1]);
			group.add(mesh);
		}

		const usMat = this.mat(
			new THREE.MeshBasicMaterial({
				color: COLORS.spawnUS,
				side: THREE.DoubleSide,
				transparent: true,
				opacity: 0.7,
				depthWrite: false,
			}),
		);
		for (const sp of US_SPAWNS) {
			const g = this.geo(new THREE.PlaneGeometry(300, 300));
			shapeGeoToXZ(g);
			const mesh = new THREE.Mesh(g, usMat);
			mesh.position.set(sp.position[0], Y_MARKERS, sp.position[1]);
			group.add(mesh);
		}

		const tankerMat = this.mat(
			new THREE.MeshBasicMaterial({
				color: COLORS.spawnTanker,
				side: THREE.DoubleSide,
				transparent: true,
				opacity: 0.7,
				depthWrite: false,
			}),
		);
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
		group.renderOrder = 5;

		const borderMat = this.mat(
			new THREE.LineBasicMaterial({
				color: 0xff2200,
				transparent: true,
				opacity: 0.6,
			}),
		);

		for (const zone of EXCLUSION_ZONES) {
			// Polygon fill
			const poly = zone.polygon.map((p) => [p[0], p[1]] as [number, number]);
			const { mesh, geo, mat } = createFilledShapes(
				[poly],
				0xff2200,
				0.15,
				Y_OVERLAYS,
				false,
			);
			this.geo(geo);
			this.mat(mat);
			mesh.renderOrder = 5;
			group.add(mesh);

			// Border outline
			const pts = zone.polygon.map(
				(p) => new THREE.Vector3(p[0], Y_OVERLAYS, p[1]),
			);
			pts.push(pts[0].clone()); // close the loop
			const lineGeo = this.geo(new THREE.BufferGeometry().setFromPoints(pts));
			const line = new THREE.Line(lineGeo, borderMat);
			group.add(line);
		}

		this.root.add(group);
		return group;
	}
}
