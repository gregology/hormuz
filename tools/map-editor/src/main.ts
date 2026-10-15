import {
	ThreeMapRenderer,
	DEFAULT_LAYERS,
	type MapLayers,
} from "../../../client/src/render/map-renderer";
import { ThreeScene } from "../../../client/src/render/scene";
import { atStraitHour } from "../../../client/src/render/solar";
import { createCamera, screenToWorld } from "../../../client/src/render/camera";
import { MAP } from "../../../client/src/map/data";
import { ZoneOverlay } from "./zone-overlay";
import { EditorState } from "./editor-state";
import { buildUI } from "./ui";
import { exportYAML } from "./yaml";

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------

const viewport = document.getElementById("viewport")!;

const threeScene = await ThreeScene.create();
viewport.prepend(threeScene.renderer.domElement);
// Edit in late-morning light regardless of the real time in the strait.
threeScene.environment.setTime(atStraitHour(new Date(), 10.5));

const screenW = viewport.clientWidth;
const screenH = viewport.clientHeight;
threeScene.setSize(screenW, screenH);

const cam = createCamera(screenW, screenH);
cam.zoom = 0.03;
cam.worldX = MAP.center.x;
cam.worldY = MAP.center.y;

const layers: MapLayers = {
	...DEFAULT_LAYERS,
	showSpawnPoints: true,
	showExclusionZones: false, // we render our own editable overlay
};
const threeMap = new ThreeMapRenderer(layers, threeScene.environment.reflections);
threeScene.scene.add(threeMap.root);

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const overlay = new ZoneOverlay(threeScene.scene);
const editor = new EditorState();
editor.getHitRadius = () => overlay.hitRadius(cam.zoom);

function rebuildOverlay(): void {
	overlay.rebuild(editor);
	threeMap.updateLanes(editor.data.lanes);
}

const ui = buildUI(
	editor,
	() => {
		const yaml = exportYAML(editor.data);
		const blob = new Blob([yaml], { type: "text/yaml" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "map.yaml";
		a.click();
		URL.revokeObjectURL(url);
	},
	rebuildOverlay,
);

rebuildOverlay();
ui.refreshAll();

// ---------------------------------------------------------------------------
// Camera controls (pan + zoom)
// ---------------------------------------------------------------------------

let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panCamStartX = 0;
let panCamStartY = 0;

const canvas = threeScene.renderer.domElement;

canvas.addEventListener("wheel", (e) => {
	e.preventDefault();
	const factor = e.deltaY > 0 ? 0.85 : 1.18;
	cam.zoom = Math.max(0.005, Math.min(2, cam.zoom * factor));
	overlay.updateHandleScale(cam.zoom);
	rebuildOverlay();
});

canvas.addEventListener("mousedown", (e) => {
	if (e.button === 1 || e.button === 2) {
		isPanning = true;
		panStartX = e.clientX;
		panStartY = e.clientY;
		panCamStartX = cam.worldX;
		panCamStartY = cam.worldY;
		e.preventDefault();
		return;
	}

	if (e.button === 0) {
		const rect = canvas.getBoundingClientRect();
		const world = screenToWorld(cam, e.clientX - rect.left, e.clientY - rect.top);
		editor.onMouseDown(world.x, world.y, e.shiftKey);
		rebuildOverlay();
		ui.refreshItemList();
		ui.refreshProperties();
		ui.refreshStatus();
	}
});

canvas.addEventListener("mousemove", (e) => {
	const rect = canvas.getBoundingClientRect();
	const world = screenToWorld(cam, e.clientX - rect.left, e.clientY - rect.top);

	if (isPanning) {
		const dx = e.clientX - panStartX;
		const dy = e.clientY - panStartY;
		const worldDelta = screenToWorld(cam, cam.screenWidth / 2 + dx, cam.screenHeight / 2 + dy);
		const worldCenter = screenToWorld(cam, cam.screenWidth / 2, cam.screenHeight / 2);
		cam.worldX = panCamStartX - (worldDelta.x - worldCenter.x);
		cam.worldY = panCamStartY - (worldDelta.y - worldCenter.y);
		return;
	}

	editor.onMouseMove(world.x, world.y);
	if (editor.isDragging) rebuildOverlay();
	ui.refreshCoords(world.x, world.y);
});

canvas.addEventListener("mouseup", (e) => {
	if (isPanning && (e.button === 1 || e.button === 2)) {
		isPanning = false;
		return;
	}
	if (e.button === 0) editor.onMouseUp();
});

canvas.addEventListener("dblclick", (e) => {
	const rect = canvas.getBoundingClientRect();
	const world = screenToWorld(cam, e.clientX - rect.left, e.clientY - rect.top);
	editor.onDoubleClick(world.x, world.y);
	rebuildOverlay();
	ui.refreshItemList();
	ui.refreshProperties();
	ui.refreshStatus();
});

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// Keyboard shortcuts
window.addEventListener("keydown", (e) => {
	if ((e.target as HTMLElement).tagName === "INPUT") return;

	if (e.key === "s" || e.key === "S") {
		editor.setMode("select");
	} else if (e.key === "d" || e.key === "D") {
		editor.setMode("draw");
	} else if (e.key === "Delete" || e.key === "Backspace") {
		editor.deleteSelected();
	} else if (e.key === "Escape") {
		editor.cancelDraw();
	} else if (e.key === "Enter") {
		editor.finishDraw();
	} else {
		return;
	}
	rebuildOverlay();
	ui.refreshAll();
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

window.addEventListener("resize", () => {
	const w = viewport.clientWidth;
	const h = viewport.clientHeight;
	threeScene.setSize(w, h);
	cam.screenWidth = w;
	cam.screenHeight = h;
});

// ---------------------------------------------------------------------------
// Layers toggle
// ---------------------------------------------------------------------------

const layerDefs: { key: keyof MapLayers; label: string }[] = [
	{ key: "showDepthZones", label: "Depth zones" },
	{ key: "showShippingLanes", label: "Shipping lanes" },
	{ key: "showHazards", label: "Hazards" },
	{ key: "showSpawnPoints", label: "Spawn points" },
	{ key: "showTerrain", label: "Terrain" },
	{ key: "showGrid", label: "Grid" },
];

const layersPanel = document.getElementById("layers-panel")!;
for (const def of layerDefs) {
	const row = document.createElement("div");
	row.className = "layer-row";
	const cb = document.createElement("input");
	cb.type = "checkbox";
	cb.checked = layers[def.key] as boolean;
	cb.addEventListener("change", () => {
		Object.assign(layers, { [def.key]: cb.checked });
		threeMap.setLayers(layers);
	});
	const span = document.createElement("span");
	span.textContent = def.label;
	row.appendChild(cb);
	row.appendChild(span);
	layersPanel.appendChild(row);
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function animate(): void {
	requestAnimationFrame(animate);
	threeScene.syncCamera(cam.worldX, cam.worldY, cam.zoom, cam.screenWidth, cam.screenHeight);
	overlay.updateHandleScale(cam.zoom);
	threeScene.render();
}

animate();
