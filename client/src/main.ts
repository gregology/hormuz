/**
 * Hormuz game client — connects to server, renders entities, sends input.
 *
 * Single Three.js canvas with a DOM HUD overlay.
 */

import { ThreeEffectManager } from "./effects/manager";
import { EntityStore } from "./game/entities";
import { SnapshotInterpolator } from "./game/interpolation";
import { InputManager } from "./input/input-manager";
import type { CameraMode } from "./input/keyboard";
import { MouseLook } from "./input/mouse-look";
import { MAP } from "./map/data";
import { getElevation } from "./map/heightmap";
import { GameConnection } from "./net/connection";
import { type Camera, createCamera } from "./render/camera";
import { ChaseCamera } from "./render/chase-camera";
import { CiwsController } from "./render/ciws-controller";
import { COLORS } from "./render/colors";
import type { GameStats, VehicleInstruments } from "./render/hud";
import { HUD } from "./render/hud";
import {
	DEFAULT_LAYERS,
	type MapLayers,
	ThreeMapRenderer,
} from "./render/map-renderer";
import { ThreeScene } from "./render/scene";
import { formatStraitTime } from "./render/solar";
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
	quadcopter: { size: 2, airborne: true, equilibriumSpeed: 22 },
};

async function init() {
	// biome-ignore lint/style/noNonNullAssertion: element defined in index.html
	const container = document.getElementById("game-container")!;
	const screenW = window.innerWidth;
	const screenH = window.innerHeight;

	// --- Three.js canvas (WebGPU, falling back to WebGL2) ---
	const threeScene = await ThreeScene.create();
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
	const threeMap = new ThreeMapRenderer(
		layers,
		threeScene.environment.reflections,
	);
	threeScene.scene.add(threeMap.root);

	// --- Three.js vehicles ---
	const threeVehicles = new ThreeVehicleRenderer();
	threeScene.scene.add(threeVehicles.root);

	// --- Three.js effects ---
	const threeEffects = new ThreeEffectManager();
	threeScene.scene.add(threeEffects.root);

	// --- CIWS autocannon controller ---
	const ciwsController = new CiwsController();
	threeScene.scene.add(ciwsController.root);

	// --- Game state ---
	const entityStore = new EntityStore();
	const interpolator = new SnapshotInterpolator();
	const input = new InputManager(container);
	const conn = new GameConnection();

	let assignedEntityId: number | null = null;
	let assignedVehicleType = "";
	let warCost: GameStats = {
		totalUsd: 0,
		tankersDelivered: 0,
		tankersSunk: 0,
		frigatesSunk: 0,
		shahedsIntercepted: 0,
		quadcoptersIntercepted: 0,
		speedboatsSunk: 0,
		playersOnline: 0,
	};
	let autopilotOn = true;

	// Zoom limits per vehicle type (scaled roughly by inverse vehicle size)
	const ZOOM_LIMITS: Record<
		string,
		{ min: number; max: number; default: number }
	> = {
		oil_tanker: { min: 0.005, max: 2, default: 0.04 },
		shahed: { min: 0.08, max: 10, default: 2 },
		speedboat: { min: 0.02, max: 5, default: 0.15 },
		frigate: { min: 0.008, max: 3, default: 0.06 },
		quadcopter: { min: 0.15, max: 15, default: 4 },
	};
	const DEFAULT_ZOOM_LIMITS = { min: 0.005, max: 2, default: 0.04 };
	let zoomLimits = DEFAULT_ZOOM_LIMITS;

	// Spectator mode: after death, free camera until player presses space to respawn
	let spectating = false;
	let pendingAssign: { entityId: number; vehicleType: string } | null = null;
	const SPECTATOR_ZOOM = { min: 0.005, max: 10 };

	// Perspective camera (third-person): mouse/touch look-around, keyboard steers
	let prevCameraMode: CameraMode = "isometric";
	const chaseCamera = new ChaseCamera();
	const mouseLook = new MouseLook(threeScene.renderer.domElement);

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

		// Reset throttle and autopilot for the new vehicle
		input.throttleLevel = 0;
		autopilotOn = vehicleType === "oil_tanker";
		input.autopilotOn = autopilotOn;
		input.updateVehicleType(vehicleType);

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
		if (!spectating && input.cameraMode !== "isometric") return;
		const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
		const limits = spectating ? SPECTATOR_ZOOM : zoomLimits;
		cam.zoom = Math.max(
			limits.min,
			Math.min(limits.max, cam.zoom * zoomFactor),
		);
	});

	// --- Pinch-to-zoom (mobile) ---
	let pinchStartDist = 0;
	let pinchStartZoom = 0;

	container.addEventListener("touchstart", (e: TouchEvent) => {
		if (e.touches.length === 2) {
			const dx = e.touches[1].clientX - e.touches[0].clientX;
			const dy = e.touches[1].clientY - e.touches[0].clientY;
			pinchStartDist = Math.hypot(dx, dy);
			pinchStartZoom = cam.zoom;
		}
	});

	container.addEventListener("touchmove", (e: TouchEvent) => {
		if (e.touches.length !== 2 || pinchStartDist === 0) return;
		if (!spectating && input.cameraMode !== "isometric") return;
		const dx = e.touches[1].clientX - e.touches[0].clientX;
		const dy = e.touches[1].clientY - e.touches[0].clientY;
		const dist = Math.hypot(dx, dy);
		const scale = dist / pinchStartDist;
		const limits = spectating ? SPECTATOR_ZOOM : zoomLimits;
		cam.zoom = Math.max(
			limits.min,
			Math.min(limits.max, pinchStartZoom * scale),
		);
	});

	container.addEventListener("touchend", () => {
		pinchStartDist = 0;
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
		const renderTime = now / 1000;

		// --- Autopilot logic (tankers only) ---
		if (assignedVehicleType === "oil_tanker" && !spectating) {
			if (input.consumeAutopilotToggle()) {
				autopilotOn = !autopilotOn;
				input.autopilotOn = autopilotOn;
			}
			if (input.consumeSteerInput() && autopilotOn) {
				autopilotOn = false;
				input.autopilotOn = false;
			}
		} else {
			input.consumeAutopilotToggle();
			input.consumeSteerInput();
		}

		// Send input to server
		const isShip =
			assignedVehicleType === "oil_tanker" ||
			assignedVehicleType === "frigate" ||
			assignedVehicleType === "speedboat";
		const throttleFloat = isShip ? input.throttleFloat : 0.0;
		conn.sendInput(
			input.getBitmask(),
			throttleFloat,
			autopilotOn && assignedVehicleType === "oil_tanker",
		);

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
		if (spectating && pendingAssign && input.isDown(" ")) {
			applyAssignment(pendingAssign.entityId, pendingAssign.vehicleType);
		}

		// Consume camera mode change (resets to isometric when spectating)
		const cameraMode = spectating ? "isometric" : input.cameraMode;
		input.consumeCameraModeChange();

		// Camera: follow vehicle when playing, WASD pan when spectating
		if (spectating) {
			const panSpeed = 500 / cam.zoom;
			if (input.isDown("w") || input.isDown("arrowup"))
				cam.worldY -= panSpeed * dt;
			if (input.isDown("s") || input.isDown("arrowdown"))
				cam.worldY += panSpeed * dt;
			if (input.isDown("a") || input.isDown("arrowleft"))
				cam.worldX -= panSpeed * dt;
			if (input.isDown("d") || input.isDown("arrowright"))
				cam.worldX += panSpeed * dt;
		} else if (assignedEntityId !== null) {
			const target = entities.find((e) => e.id === assignedEntityId);
			if (target) {
				const altOffset = VEHICLE_DEFAULTS[target.vehicleType]?.airborne
					? 30
					: 0;
				cam.worldX = target.x - altOffset;
				cam.worldY = target.y - altOffset;
			}
		}

		// Update the perspective camera for third-person mode
		mouseLook.enabled = cameraMode !== "isometric";
		const look = mouseLook.consume();
		if (cameraMode !== "isometric" && assignedEntityId !== null) {
			const target = entities.find((e) => e.id === assignedEntityId);
			if (target) {
				const defaults = VEHICLE_DEFAULTS[target.vehicleType];
				const switched = prevCameraMode !== cameraMode;
				if (switched) chaseCamera.reset(cameraMode, target.heading);
				chaseCamera.look(cameraMode, look.dx, look.dy);
				if (look.wheel !== 0) chaseCamera.zoomBy(look.wheel);
				chaseCamera.apply(
					threeScene.perspCamera,
					cameraMode,
					{
						x: target.x,
						y: target.y,
						heading: target.heading,
						baseHeight: defaults?.airborne
							? getElevation(target.x, target.y) + 30
							: 0,
						size: defaults?.size ?? 50,
					},
					dt,
					switched,
				);
			}
		}
		prevCameraMode = cameraMode;

		// Update Three.js objects
		// In perspective mode, compute an equivalent ortho zoom so effects
		// (wake ribbons, water shader) are sized consistently with the view.
		const SQRT6 = 2.449489742783178;
		let effectZoom: number;
		if (cameraMode === "isometric") {
			effectZoom = cam.zoom;
		} else {
			const sz = VEHICLE_DEFAULTS[assignedVehicleType ?? ""]?.size ?? 50;
			const dist = sz * chaseCamera.settings.distance * chaseCamera.zoom;
			const halfFov = (threeScene.perspCamera.fov * Math.PI) / 360;
			effectZoom = cam.screenWidth / (SQRT6 * 2 * dist * Math.tan(halfFov));
		}
		// Lighting follows the real time of day in the strait.
		const wallClock = new Date();
		threeScene.environment.setTime(wallClock);
		threeVehicles.update(
			entities,
			assignedEntityId,
			assignedVehicleType,
			FACTION_COLORS,
			effectZoom,
		);
		ciwsController.update(
			entities,
			(id) => threeVehicles.getCiwsTurret(id),
			dt,
			effectZoom,
		);
		threeEffects.update(entities, dt, effectZoom);

		// Render Three.js scene (map + vehicles + effects)
		if (cameraMode === "isometric") {
			threeScene.syncCamera(
				cam.worldX,
				cam.worldY,
				cam.zoom,
				cam.screenWidth,
				cam.screenHeight,
			);
			threeScene.render();
		} else {
			threeScene.renderPerspective();
		}

		// HUD
		hud.updateVehicle(
			spectating,
			pendingAssign !== null,
			assignedVehicleType,
			cameraMode === "isometric"
				? "none"
				: mouseLook.captured
					? "active"
					: "available",
		);
		input.updateSpectating(spectating, pendingAssign !== null);
		hud.updateStats(warCost);
		hud.updateClock(formatStraitTime(wallClock));

		// Vehicle instruments — speed, heading, HP, flood
		if (!spectating && assignedEntityId !== null) {
			const playerEntity = entities.find((e) => e.id === assignedEntityId);
			if (playerEntity) {
				const instruments: VehicleInstruments = {
					speed: playerEntity.speed,
					heading: playerEntity.heading,
					x: playerEntity.x,
					y: playerEntity.y,
					hp: playerEntity.hp,
					maxHp: 0,
					floodLevel: playerEntity.floodLevel ?? 0,
					vehicleType: playerEntity.vehicleType,
					batteryPct: playerEntity.batteryPct ?? -1,
				};
				hud.updateInstruments(instruments);
			} else {
				hud.updateInstruments(null);
			}
		} else {
			hud.updateInstruments(null);
		}

		const showShipHud = isShip && !spectating;
		hud.updateThrottle(input.throttleLevel, showShipHud);
		hud.updateAutopilot(
			autopilotOn,
			assignedVehicleType === "oil_tanker" && !spectating,
		);
	}

	requestAnimationFrame(frame);

	console.log("Hormuz client started");
}

init();
