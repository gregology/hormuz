/**
 * Hormuz game client — connects to server, renders entities, sends input.
 *
 * Single Three.js canvas with a DOM HUD overlay.
 */

import { ThreeEffectManager } from "./effects/manager";
import { EntityStore } from "./game/entities";
import { SnapshotInterpolator } from "./game/interpolation";
import { KeyboardManager } from "./input/keyboard";
import { MAP } from "./map/data";
import { GameConnection } from "./net/connection";
import { type Camera, createCamera } from "./render/camera";
import { COLORS } from "./render/colors";
import { HUD } from "./render/hud";
import {
	DEFAULT_LAYERS,
	type MapLayers,
	ThreeMapRenderer,
} from "./render/map-renderer";
import { ThreeScene } from "./render/scene";
import { ThreeVehicleRenderer } from "./render/vehicle-renderer";

// Faction -> render color
const FACTION_COLORS: Record<string, number> = {
	civilian: COLORS.spawnTanker,
	iran: COLORS.spawnIran,
	us: COLORS.spawnUS,
};

// Vehicle defaults for rendering (only need size, airborne, equilibriumSpeed)
const VEHICLE_DEFAULTS: Record<
	string,
	{ size: number; airborne: boolean; equilibriumSpeed: number }
> = {
	oil_tanker: { size: 220, airborne: false, equilibriumSpeed: 15 },
	shahed: { size: 4, airborne: true, equilibriumSpeed: 80 },
	speedboat: { size: 10, airborne: false, equilibriumSpeed: 26 },
	frigate: { size: 100, airborne: false, equilibriumSpeed: 13.5 },
};

function init() {
	// biome-ignore lint/style/noNonNullAssertion: element defined in index.html
	const container = document.getElementById("game-container")!;
	const screenW = window.innerWidth;
	const screenH = window.innerHeight;

	// --- Three.js canvas ---
	const threeScene = new ThreeScene();
	threeScene.setSize(screenW, screenH);
	container.appendChild(threeScene.renderer.domElement);

	// --- DOM HUD overlay ---
	const hud = new HUD(container);

	// --- Camera ---
	const cam: Camera = createCamera(screenW, screenH);
	cam.worldX = MAP.center.x;
	cam.worldY = MAP.center.y;
	cam.zoom = 0.04;

	// --- Map layers (Three.js) ---
	const layers: MapLayers = { ...DEFAULT_LAYERS };
	const threeMap = new ThreeMapRenderer(layers);
	threeScene.scene.add(threeMap.root);

	// --- Three.js vehicles ---
	const threeVehicles = new ThreeVehicleRenderer();
	threeScene.scene.add(threeVehicles.root);

	// --- Three.js effects ---
	const threeEffects = new ThreeEffectManager();
	threeScene.scene.add(threeEffects.root);

	// --- Game state ---
	const entityStore = new EntityStore();
	const interpolator = new SnapshotInterpolator();
	const keyboard = new KeyboardManager();
	const conn = new GameConnection();

	let assignedEntityId: number | null = null;
	let assignedVehicleType = "";
	let warCost = { totalUsd: 0, tankersDelivered: 0, tankersSunk: 0 };
	let elapsedTime = 0;

	// Zoom limits per vehicle type (scaled roughly by inverse vehicle size)
	const ZOOM_LIMITS: Record<
		string,
		{ min: number; max: number; default: number }
	> = {
		oil_tanker: { min: 0.005, max: 2, default: 0.04 },
		shahed: { min: 0.08, max: 10, default: 2 },
		speedboat: { min: 0.02, max: 5, default: 0.15 },
		frigate: { min: 0.008, max: 3, default: 0.06 },
	};
	const DEFAULT_ZOOM_LIMITS = { min: 0.005, max: 2, default: 0.04 };
	let zoomLimits = DEFAULT_ZOOM_LIMITS;

	// Spectator mode: after death, free camera until player presses space to respawn
	let spectating = false;
	let pendingAssign: { entityId: number; vehicleType: string } | null = null;
	const SPECTATOR_ZOOM = { min: 0.005, max: 10 };

	// --- Connection handlers ---
	conn.onSnapshot((snapshot) => {
		entityStore.applySnapshot(snapshot);
		const now = performance.now() / 1000;
		interpolator.pushSnapshot(entityStore.entities, now);
	});

	conn.onAssign((msg) => {
		if (assignedEntityId === null) {
			// First assignment on connect — apply immediately
			applyAssignment(msg.entityId, msg.vehicleType);
			return;
		}
		// Reassignment after death — queue it, enter spectator mode
		pendingAssign = { entityId: msg.entityId, vehicleType: msg.vehicleType };
		spectating = true;
	});

	function applyAssignment(entityId: number, vehicleType: string): void {
		assignedEntityId = entityId;
		assignedVehicleType = vehicleType;
		spectating = false;
		pendingAssign = null;

		// Update zoom limits and reset zoom for the new vehicle type
		zoomLimits = ZOOM_LIMITS[vehicleType] ?? DEFAULT_ZOOM_LIMITS;
		cam.zoom = zoomLimits.default;

		// Snap camera to the new vehicle
		const now = performance.now() / 1000;
		const snap = interpolator.getAllInterpolated(now);
		const target = snap.find((e) => e.id === entityId);
		if (target) {
			cam.worldX = target.x;
			cam.worldY = target.y;
		}
	}

	conn.onWarCost((msg) => {
		warCost = msg;
	});

	conn.onEvent((msg) => {
		if (msg.eventType === "explosion") {
			threeEffects.spawnExplosion(msg.x, msg.y);
		}
	});

	// --- Connect ---
	const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
	conn.connect(`${wsProtocol}//${location.host}/ws`);

	// --- Mouse wheel zoom ---
	container.addEventListener("wheel", (e: WheelEvent) => {
		e.preventDefault();
		const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
		const limits = spectating ? SPECTATOR_ZOOM : zoomLimits;
		cam.zoom = Math.max(
			limits.min,
			Math.min(limits.max, cam.zoom * zoomFactor),
		);
	});

	// --- Resize handler ---
	window.addEventListener("resize", () => {
		const w = window.innerWidth;
		const h = window.innerHeight;
		cam.screenWidth = w;
		cam.screenHeight = h;
		threeScene.setSize(w, h);
	});

	// --- Render loop ---
	let lastTime = performance.now();

	function frame(now: number): void {
		requestAnimationFrame(frame);

		const dt = (now - lastTime) / 1000;
		lastTime = now;
		elapsedTime += dt;
		const renderTime = now / 1000;

		// Send input to server
		conn.sendInput(keyboard.getBitmask());

		// Get interpolated entities
		const entities = interpolator.getAllInterpolated(renderTime);

		// Detect player death: assigned entity's HP drops to zero
		if (assignedEntityId !== null && !spectating) {
			const assigned = entities.find((e) => e.id === assignedEntityId);
			if (assigned && assigned.hp <= 0) {
				spectating = true;
			}
		}

		// Spectator mode: press space to respawn
		if (spectating && pendingAssign && keyboard.isDown(" ")) {
			applyAssignment(pendingAssign.entityId, pendingAssign.vehicleType);
		}

		// Camera: follow vehicle when playing, WASD pan when spectating
		if (spectating) {
			const panSpeed = 500 / cam.zoom;
			if (keyboard.isDown("w") || keyboard.isDown("arrowup"))
				cam.worldY -= panSpeed * dt;
			if (keyboard.isDown("s") || keyboard.isDown("arrowdown"))
				cam.worldY += panSpeed * dt;
			if (keyboard.isDown("a") || keyboard.isDown("arrowleft"))
				cam.worldX -= panSpeed * dt;
			if (keyboard.isDown("d") || keyboard.isDown("arrowright"))
				cam.worldX += panSpeed * dt;
		} else if (assignedEntityId !== null) {
			const target = entities.find((e) => e.id === assignedEntityId);
			if (target) {
				const followSpeed = 5;
				const altOffset = VEHICLE_DEFAULTS[target.vehicleType]?.airborne
					? 30
					: 0;
				cam.worldX += (target.x - altOffset - cam.worldX) * followSpeed * dt;
				cam.worldY += (target.y - altOffset - cam.worldY) * followSpeed * dt;
			}
		}

		// Update Three.js objects
		threeMap.update(elapsedTime, cam.zoom);
		threeVehicles.update(entities, assignedEntityId, FACTION_COLORS);
		threeEffects.update(entities, dt, cam.zoom);

		// Render Three.js scene (map + vehicles + effects)
		threeScene.syncCamera(
			cam.worldX,
			cam.worldY,
			cam.zoom,
			cam.screenWidth,
			cam.screenHeight,
		);
		threeScene.render();

		// HUD
		hud.updateVehicle(spectating, pendingAssign !== null, assignedVehicleType);
		hud.updateCost(
			warCost.totalUsd,
			warCost.tankersDelivered,
			warCost.tankersSunk,
		);
		const entityCount = entities.filter((e) => e.hp > 0).length;
		hud.updateStatus(entityCount, cam.zoom);
	}

	requestAnimationFrame(frame);

	console.log("Hormuz client started");
}

init();
