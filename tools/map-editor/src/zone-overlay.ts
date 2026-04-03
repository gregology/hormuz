import * as THREE from "three";
import type { EditorState, EditableSpawn, EditableRock, EditableZone } from "./editor-state";

const Y_OVERLAY = 0.5;
const Y_HANDLE = 0.55;
/** Desired handle size in screen pixels. */
const HANDLE_SCREEN_PX = 6;

const COLORS = {
	zone: 0xff2200,
	selected: 0x3b82f6,
	drawing: 0x34d399,
	handle: 0xffffff,
	spawn: 0xfbbf24,
	shallowWater: 0x60a5fa,
	shoal: 0xf59e0b,
	rock: 0xef4444,
	lane: 0x8b5cf6,
	destination: 0x22d3ee,
	landmark: 0xf472b6,
	point: 0xfbbf24,
};

export class ZoneOverlay {
	readonly root = new THREE.Group();
	private geometries: THREE.BufferGeometry[] = [];
	private materials: THREE.Material[] = [];
	private currentZoom = 0.03;

	constructor(scene: THREE.Scene) {
		scene.add(this.root);
	}

	rebuild(editor: EditorState): void {
		this.dispose();

		const layer = editor.activeLayer;
		const items = editor.getItems();

		if (layer.kind === "polygon") {
			this.renderPolygonLayer(editor, items);
		} else if (layer.kind === "point") {
			this.renderPointLayer(editor, items);
		} else if (layer.kind === "polyline") {
			this.renderPolylineLayer(editor, items as [number, number][]);
		}

		// Drawing-in-progress
		if (editor.drawingVertices.length > 0) {
			this.renderDrawing(editor.drawingVertices, layer.kind === "polygon");
		}

	}

	updateHandleScale(zoom: number): void {
		if (zoom !== this.currentZoom) {
			this.currentZoom = zoom;
		}
	}

	hitRadius(zoom: number): number {
		return HANDLE_SCREEN_PX * 2.5 / Math.max(zoom, 0.005);
	}

	private handleRadius(): number {
		return HANDLE_SCREEN_PX / Math.max(this.currentZoom, 0.005);
	}

	private renderPolygonLayer(editor: EditorState, items: unknown[]): void {
		const layerKey = editor.activeLayerKey;
		const baseColor = layerKey === "exclusionZones" ? COLORS.zone
			: layerKey.includes("shallow") || layerKey.includes("Shallow") ? COLORS.shallowWater
			: COLORS.shoal;

		for (let i = 0; i < items.length; i++) {
			const isSelected = i === editor.selectedIndex;
			let verts: [number, number][];
			if (layerKey === "exclusionZones") {
				verts = (items[i] as EditableZone).polygon;
			} else {
				verts = items[i] as [number, number][];
			}

			const color = isSelected ? COLORS.selected : baseColor;
			const alpha = isSelected ? 0.25 : 0.15;

			if (verts.length >= 3) {
				this.addPolygonFill(verts, color, alpha);
			}
			if (verts.length >= 2) {
				this.addPolyline(verts, color, isSelected ? 0.9 : 0.6, true);
			}
			if (isSelected) {
				for (const pt of verts) this.addHandle(pt[0], pt[1], COLORS.handle);
			}
		}
	}

	private renderPointLayer(editor: EditorState, items: unknown[]): void {
		const layerKey = editor.activeLayerKey;
		const hasArea = editor.getActiveAreaWithRadius() !== null;
		const isLandmark = layerKey.startsWith("landmark_");
		const baseColor = layerKey === "rocks" ? COLORS.rock
			: hasArea ? COLORS.destination
			: isLandmark ? COLORS.landmark
			: COLORS.spawn;

		for (let i = 0; i < items.length; i++) {
			const isSelected = i === editor.selectedIndex;
			const pos = editor.getItemPosition(i);
			if (!pos) continue;

			const color = isSelected ? COLORS.selected : baseColor;

			if (layerKey === "rocks") {
				const rock = items[i] as EditableRock;
				this.addCircle(pos[0], pos[1], rock.radius, color, 0.4);
			}

			// Area radius (destinations + patrol zones)
			if (hasArea) {
				const area = editor.getActiveAreaWithRadius()!;
				this.addCircle(pos[0], pos[1], area.radius, color, 0.1);
				this.addCircleRing(pos[0], pos[1], area.radius, color, isSelected ? 0.6 : 0.35);
			}

			this.addHandle(pos[0], pos[1], color);

			// Scatter radius + heading indicator for spawns
			if (!hasArea && !isLandmark && layerKey !== "rocks") {
				const spawn = items[i] as EditableSpawn;
				if (spawn.scatterRadius > 0) {
					this.addCircleRing(pos[0], pos[1], spawn.scatterRadius, color, isSelected ? 0.4 : 0.2);
				}
				if (spawn.heading !== undefined) {
					const len = 800;
					const ex = pos[0] + Math.cos(spawn.heading) * len;
					const ey = pos[1] + Math.sin(spawn.heading) * len;
					this.addLine(pos[0], pos[1], ex, ey, color, 0.6);
				}
			}
		}
	}

	private renderPolylineLayer(editor: EditorState, verts: [number, number][]): void {
		if (verts.length < 2) return;

		const isSelected = editor.selectedIndex === 0;
		const color = isSelected ? COLORS.selected : COLORS.lane;
		this.addPolyline(verts, color, isSelected ? 0.9 : 0.6, false);

		if (isSelected) {
			for (const pt of verts) this.addHandle(pt[0], pt[1], COLORS.handle);
		}
	}

	private renderDrawing(verts: [number, number][], closed: boolean): void {
		if (verts.length >= 2) {
			this.addPolyline(verts, COLORS.drawing, 0.8, false);
		}
		for (const pt of verts) {
			this.addHandle(pt[0], pt[1], COLORS.drawing);
		}
		// Preview closing edge
		if (closed && verts.length >= 3) {
			this.addLine(
				verts[verts.length - 1][0], verts[verts.length - 1][1],
				verts[0][0], verts[0][1], COLORS.drawing, 0.4,
			);
		}
	}

	// --- Geometry helpers ---

	private addPolygonFill(verts: [number, number][], color: number, alpha: number): void {
		const shape = new THREE.Shape();
		shape.moveTo(verts[0][0], verts[0][1]);
		for (let i = 1; i < verts.length; i++) shape.lineTo(verts[i][0], verts[i][1]);
		const geo = this.track(new THREE.ShapeGeometry(shape));
		remapXZ(geo);
		const mat = this.trackMat(new THREE.MeshBasicMaterial({
			color, transparent: true, opacity: alpha, side: THREE.DoubleSide,
			depthWrite: false,
		}));
		const mesh = new THREE.Mesh(geo, mat);
		mesh.position.y = Y_OVERLAY;
		mesh.renderOrder = 100;
		this.root.add(mesh);
	}

	private addPolyline(verts: [number, number][], color: number, opacity: number, close: boolean): void {
		const pts = verts.map((p) => new THREE.Vector3(p[0], Y_OVERLAY, p[1]));
		if (close) pts.push(pts[0].clone());
		const geo = this.track(new THREE.BufferGeometry().setFromPoints(pts));
		const mat = this.trackMat(new THREE.LineBasicMaterial({
			color, transparent: true, opacity,
		}));
		const line = new THREE.Line(geo, mat);
		line.renderOrder = 101;
		this.root.add(line);
	}

	private addLine(x1: number, y1: number, x2: number, y2: number, color: number, opacity: number): void {
		const pts = [new THREE.Vector3(x1, Y_OVERLAY, y1), new THREE.Vector3(x2, Y_OVERLAY, y2)];
		const geo = this.track(new THREE.BufferGeometry().setFromPoints(pts));
		const mat = this.trackMat(new THREE.LineBasicMaterial({
			color, transparent: true, opacity,
		}));
		const line = new THREE.Line(geo, mat);
		line.renderOrder = 101;
		this.root.add(line);
	}

	private addCircle(x: number, z: number, radius: number, color: number, opacity: number): void {
		const geo = this.track(new THREE.CircleGeometry(radius, 24));
		remapXZ(geo);
		const mat = this.trackMat(new THREE.MeshBasicMaterial({
			color, transparent: true, opacity, side: THREE.DoubleSide,
			depthWrite: false,
		}));
		const mesh = new THREE.Mesh(geo, mat);
		mesh.position.set(x, Y_OVERLAY, z);
		mesh.renderOrder = 100;
		this.root.add(mesh);
	}

	private addCircleRing(x: number, z: number, radius: number, color: number, opacity: number): void {
		const segments = 48;
		const pts: THREE.Vector3[] = [];
		for (let i = 0; i <= segments; i++) {
			const angle = (i / segments) * Math.PI * 2;
			pts.push(new THREE.Vector3(
				x + Math.cos(angle) * radius,
				Y_OVERLAY,
				z + Math.sin(angle) * radius,
			));
		}
		const geo = this.track(new THREE.BufferGeometry().setFromPoints(pts));
		const mat = this.trackMat(new THREE.LineBasicMaterial({
			color, transparent: true, opacity,
		}));
		const line = new THREE.Line(geo, mat);
		line.renderOrder = 101;
		this.root.add(line);
	}

	private addHandle(x: number, z: number, color: number): void {
		const r = this.handleRadius();
		const geo = this.track(new THREE.CircleGeometry(r, 16));
		remapXZ(geo);
		const mat = this.trackMat(new THREE.MeshBasicMaterial({
			color, side: THREE.DoubleSide,
			transparent: true, depthWrite: false,
		}));
		const mesh = new THREE.Mesh(geo, mat);
		mesh.position.set(x, Y_HANDLE, z);
		mesh.renderOrder = 100;
		this.root.add(mesh);
	}

	private dispose(): void {
		for (const g of this.geometries) g.dispose();
		for (const m of this.materials) m.dispose();
		this.geometries = [];
		this.materials = [];
		while (this.root.children.length > 0) this.root.remove(this.root.children[0]);
	}

	private track<T extends THREE.BufferGeometry>(g: T): T { this.geometries.push(g); return g; }
	private trackMat<T extends THREE.Material>(m: T): T { this.materials.push(m); return m; }
}

function remapXZ(geo: THREE.BufferGeometry): void {
	const pos = geo.getAttribute("position") as THREE.BufferAttribute;
	for (let i = 0; i < pos.count; i++) {
		const y = pos.getY(i);
		pos.setY(i, 0);
		pos.setZ(i, y);
	}
	pos.needsUpdate = true;
}
