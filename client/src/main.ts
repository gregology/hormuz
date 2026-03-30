/**
 * Hormuz game client — connects to server, renders entities, sends input.
 */

import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { EffectManager } from "./effects/manager";
import { EntityStore } from "./game/entities";
import { SnapshotInterpolator } from "./game/interpolation";
import { KeyboardManager } from "./input/keyboard";
import { MAP } from "./map/data";
import { GameConnection } from "./net/connection";
import { type Camera, createCamera } from "./render/camera";
import { COLORS } from "./render/colors";
import {
	DEFAULT_LAYERS,
	type MapLayers,
	renderMap,
} from "./render/map-renderer";
import { renderVehicle } from "./render/vehicle-renderer";
import type { NavalVehicle, VehicleType } from "./vehicles/physics";

// Faction -> render color
const FACTION_COLORS: Record<string, number> = {
	civilian: COLORS.spawnTanker,
	iran: COLORS.spawnIran,
	us: COLORS.spawnUS,
};

// Vehicle defaults for rendering (only need size, airborne, maxSpeed)
const VEHICLE_DEFAULTS: Record<
	string,
	{ size: number; airborne: boolean; maxSpeed: number }
> = {
	oil_tanker: { size: 220, airborne: false, maxSpeed: 7.5 },
	shahed: { size: 4, airborne: true, maxSpeed: 40 },
	speedboat: { size: 10, airborne: false, maxSpeed: 26 },
	frigate: { size: 100, airborne: false, maxSpeed: 13.5 },
};

async function init() {
	const app = new Application();
	await app.init({
		resizeTo: window,
		background: 0x0a1628,
		antialias: true,
	});
	document.body.appendChild(app.canvas);

	// --- Camera ---
	const cam: Camera = createCamera(app.screen.width, app.screen.height);
	cam.worldX = MAP.center.x;
	cam.worldY = MAP.center.y;
	cam.zoom = 0.04;

	// --- Graphics layers ---
	const mapContainer = new Container();
	const effectManager = new EffectManager();
	const vehicleGfx = new Graphics();
	const hudContainer = new Container();
	app.stage.addChild(mapContainer);
	app.stage.addChild(effectManager.getContainer());
	app.stage.addChild(vehicleGfx);
	app.stage.addChild(hudContainer);

	// --- Map layers ---
	const layers: MapLayers = { ...DEFAULT_LAYERS };

	// --- HUD ---
	const hudStyle = new TextStyle({
		fontFamily: "monospace",
		fontSize: 14,
		fill: 0xffffff,
		dropShadow: {
			color: 0x000000,
			distance: 1,
			blur: 2,
		},
	});
	const vehicleText = new Text({ text: "", style: hudStyle });
	vehicleText.x = 10;
	vehicleText.y = 10;
	hudContainer.addChild(vehicleText);

	const costText = new Text({ text: "", style: hudStyle });
	costText.x = 10;
	costText.y = 30;
	hudContainer.addChild(costText);

	const statusText = new Text({ text: "Connecting...", style: hudStyle });
	statusText.x = 10;
	statusText.y = 50;
	hudContainer.addChild(statusText);

	// --- Game state ---
	const entityStore = new EntityStore();
	const interpolator = new SnapshotInterpolator();
	const keyboard = new KeyboardManager();
	const conn = new GameConnection();

	let assignedEntityId: number | null = null;
	let assignedVehicleType = "";
	let warCost = { totalUsd: 0, tankersDelivered: 0, tankersSunk: 0 };
	let elapsedTime = 0;

	// Reusable NavalVehicle objects for rendering (keyed by entity ID)
	const renderVehicles = new Map<number, NavalVehicle>();

	function getOrCreateRenderVehicle(
		id: number,
		vehicleType: string,
	): NavalVehicle {
		let v = renderVehicles.get(id);
		if (!v) {
			const defaults = VEHICLE_DEFAULTS[vehicleType] ?? {
				size: 10,
				airborne: false,
				maxSpeed: 10,
			};
			v = {
				vehicleType: vehicleType as VehicleType,
				x: 0,
				y: 0,
				heading: 0,
				speed: 0,
				drift: 0,
				maxSpeed: defaults.maxSpeed,
				acceleration: 0,
				drag: 0.95,
				turnRate: 0,
				driftFactor: 0,
				lateralDrag: 0,
				minTurnFraction: 0,
				cruiseSpeed: 0,
				airborne: defaults.airborne,
				size: defaults.size,
			};
			renderVehicles.set(id, v);
		}
		return v;
	}

	// --- Connection handlers ---
	conn.onSnapshot((snapshot) => {
		entityStore.applySnapshot(snapshot);
		const now = performance.now() / 1000;
		interpolator.pushSnapshot(entityStore.entities, now);

		// Clean up render vehicles for removed entities
		for (const id of renderVehicles.keys()) {
			if (!entityStore.entities.has(id)) {
				renderVehicles.delete(id);
			}
		}
	});

	conn.onAssign((msg) => {
		assignedEntityId = msg.entityId;
		assignedVehicleType = msg.vehicleType;
	});

	conn.onWarCost((msg) => {
		warCost = msg;
	});

	conn.onEvent((msg) => {
		if (msg.eventType === "explosion") {
			effectManager.spawnExplosion(msg.x, msg.y);
		}
	});

	// --- Connect ---
	const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
	conn.connect(`${wsProtocol}//${location.host}/ws`);

	// --- Mouse wheel zoom ---
	app.canvas.addEventListener("wheel", (e: WheelEvent) => {
		e.preventDefault();
		const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
		cam.zoom = Math.max(0.005, Math.min(2, cam.zoom * zoomFactor));
	});

	// --- Resize handler ---
	window.addEventListener("resize", () => {
		cam.screenWidth = app.screen.width;
		cam.screenHeight = app.screen.height;
	});

	// --- Render loop ---
	app.ticker.add(() => {
		const dt = app.ticker.deltaMS / 1000;
		elapsedTime += dt;
		const renderTime = performance.now() / 1000;

		// Send input to server
		conn.sendInput(keyboard.getBitmask());

		// Get interpolated entities
		const entities = interpolator.getAllInterpolated(renderTime);

		// Camera follow assigned vehicle
		if (assignedEntityId !== null) {
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

		// Render map
		renderMap(mapContainer, cam, layers, elapsedTime);

		// Update and draw effects (wake trails, churns, explosions, sinking)
		effectManager.update(entities, dt);
		effectManager.draw(cam);

		// Render all vehicles
		vehicleGfx.clear();
		for (const e of entities) {
			if (e.hp <= 0) continue;

			const rv = getOrCreateRenderVehicle(e.id, e.vehicleType);
			rv.x = e.x;
			rv.y = e.y;
			rv.heading = e.heading;
			rv.speed = e.speed;
			rv.drift = e.drift;

			const color =
				e.id === assignedEntityId
					? 0xffffff
					: (FACTION_COLORS[e.faction] ?? 0xcccccc);
			renderVehicle(vehicleGfx, cam, rv, color);
		}

		// HUD
		const typeLabel =
			assignedVehicleType === "oil_tanker"
				? "Oil Tanker"
				: assignedVehicleType === "shahed"
					? "Shahed Drone"
					: assignedVehicleType || "Spectating";
		vehicleText.text = `You: ${typeLabel}  |  WASD to control`;

		const costStr = warCost.totalUsd.toLocaleString("en-US", {
			style: "currency",
			currency: "USD",
			maximumFractionDigits: 0,
		});
		costText.text = `War Cost: ${costStr}  |  Delivered: ${warCost.tankersDelivered}  Sunk: ${warCost.tankersSunk}`;

		const entityCount = entities.filter((e) => e.hp > 0).length;
		statusText.text = `Entities: ${entityCount}  |  Zoom: ${cam.zoom.toFixed(3)}  [scroll to zoom]`;
	});

	console.log("Hormuz client started");
}

init();
