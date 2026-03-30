import GUI from "lil-gui";
import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { EffectManager } from "../../client/src/effects/manager";
import { MAP } from "../../client/src/map/data";
import {
	getElevation,
	getSlopeAlongHeading,
} from "../../client/src/map/heightmap";
import {
	type Camera,
	createCamera,
	screenToWorld,
	worldToScreen,
} from "../../client/src/render/camera";
import { COLORS } from "../../client/src/render/colors";
import {
	DEFAULT_LAYERS,
	type MapLayers,
	renderMap,
} from "../../client/src/render/map-renderer";
import { renderVehicle } from "../../client/src/render/vehicle-renderer";
import {
	COLLISION_POLYGONS,
	resolveTerrainCollision,
	resolveVehicleCollisions,
} from "../../client/src/vehicles/collision";
import {
	type NavalVehicle,
	type VehicleInput,
	createFrigate,
	createOilTanker,
	createQuadcopter,
	createShahed,
	createSpeedboat,
	createTruck,
	updateVehicle,
} from "../../client/src/vehicles/physics";

const FACTION_COLORS: Record<string, number> = {
	speedboat: COLORS.spawnIran,
	frigate: COLORS.spawnUS,
	tanker: COLORS.spawnTanker,
	truck: 0xeeeeee,
	quadcopter: 0x44cc44,
	shahed: 0xcc4444,
};

interface PlayableVehicle {
	key: string;
	label: string;
	vehicle: NavalVehicle;
	color: number;
	hp: number;
	respawnTimer: number;
}

async function init() {
	const app = new Application();

	await app.init({
		resizeTo: window,
		background: 0x0a1628,
		antialias: true,
	});

	document.body.appendChild(app.canvas);

	// ---- Camera ----
	const cam: Camera = createCamera(app.screen.width, app.screen.height);
	cam.zoom = 0.04;

	// ---- Graphics layers ----
	const mapContainer = new Container();
	const effectManager = new EffectManager();
	const vehicleGfx = new Graphics();
	app.stage.addChild(mapContainer);
	app.stage.addChild(effectManager.getContainer());
	app.stage.addChild(vehicleGfx);

	// ---- Map layers ----
	const layers: MapLayers = { ...DEFAULT_LAYERS };

	// ---- Vehicles ----
	const RESPAWN_TIME = 4.0;

	const vehicles: PlayableVehicle[] = [
		{
			key: "speedboat",
			label: "Speedboat",
			vehicle: createSpeedboat(75746, 42781),
			color: FACTION_COLORS.speedboat,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "frigate",
			label: "Frigate",
			vehicle: createFrigate(75540, 43226),
			color: FACTION_COLORS.frigate,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "tanker",
			label: "Oil Tanker",
			vehicle: createOilTanker(75500, 43000),
			color: FACTION_COLORS.tanker,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "truck",
			label: "Box Truck",
			vehicle: createTruck(75698, 42649),
			color: FACTION_COLORS.truck,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "quadcopter",
			label: "Quadcopter",
			vehicle: createQuadcopter(75700, 42900),
			color: FACTION_COLORS.quadcopter,
			hp: 100,
			respawnTimer: 0,
		},
		{
			key: "shahed",
			label: "Shahed Drone",
			vehicle: createShahed(75600, 42850),
			color: FACTION_COLORS.shahed,
			hp: 100,
			respawnTimer: 0,
		},
	];

	const SPAWN_POSITIONS = [
		[75746, 42781],
		[75540, 43226],
		[75500, 43000],
		[75698, 42649],
		[75700, 42900],
		[75600, 42850],
	];

	// Set initial headings (all heading west through the strait)
	for (const pv of vehicles) {
		pv.vehicle.heading = Math.PI;
	}

	let activeIndex = 0;

	function activeVehicle(): NavalVehicle {
		return vehicles[activeIndex].vehicle;
	}

	// Camera starts on active vehicle
	cam.worldX = activeVehicle().x;
	cam.worldY = activeVehicle().y;

	// ---- HUD ----
	const hudStyle = new TextStyle({
		fontFamily: "monospace",
		fontSize: 14,
		fill: 0xaaaaaa,
	});
	const coordText = new Text({ text: "", style: hudStyle });
	coordText.x = 10;
	coordText.y = app.screen.height - 50;
	app.stage.addChild(coordText);

	const boatText = new Text({ text: "", style: hudStyle });
	boatText.x = 10;
	boatText.y = app.screen.height - 30;
	app.stage.addChild(boatText);

	// ---- Input state ----
	const keysDown = new Set<string>();
	let isDragging = false;
	let lastMouseX = 0;
	let lastMouseY = 0;
	let mouseScreenX = 0;
	let mouseScreenY = 0;
	let elapsedTime = 0;

	const mode = { cameraFollow: true, freeCamera: false };

	// ---- Simulation settings ----
	const simSettings = { timeScale: 1.0, showCollisionPolygons: true };

	// ---- Dev panel ----
	const gui = new GUI({ title: "Hormuz Playground" });

	// Vehicle stats folder — rebuilt when switching vehicles
	let vehicleFolder: GUI | null = null;

	function rebuildVehicleFolder() {
		if (vehicleFolder) vehicleFolder.destroy();
		const v = activeVehicle();
		const label = vehicles[activeIndex].label;
		vehicleFolder = gui.addFolder(`${label} [${activeIndex + 1}]`);
		vehicleFolder.add(v, "maxSpeed", 0.5, 50).name("Max Speed");
		vehicleFolder.add(v, "acceleration", 0.1, 20).name("Acceleration");
		vehicleFolder.add(v, "drag", 0.5, 0.99).name("Forward Drag");
		vehicleFolder.add(v, "turnRate", 0.05, 6).name("Turn Rate");
		vehicleFolder.add(v, "driftFactor", 0, 0.5).name("Drift Factor");
		vehicleFolder.add(v, "lateralDrag", 0.01, 0.8).name("Lateral Drag");
		vehicleFolder.add(v, "cruiseSpeed", 0, 50).name("Cruise Speed");
		vehicleFolder.add(v, "size", 0.5, 300).name("Visual Size");
		vehicleFolder.add(v, "angularDrag", 0.01, 0.5).name("Angular Drag");
	}

	rebuildVehicleFolder();

	// Camera folder
	const cameraFolder = gui.addFolder("Camera");
	cameraFolder.add(cam, "zoom", 0.02, 10).name("Zoom").listen();
	cameraFolder
		.add(mode, "freeCamera")
		.name("Free Camera (Tab)")
		.listen()
		.onChange((v: boolean) => {
			mode.cameraFollow = !v;
		});

	// Simulation folder
	const simFolder = gui.addFolder("Simulation");
	simFolder
		.add(simSettings, "timeScale", 0.1, 3.0)
		.name("Time Scale")
		.step(0.1);
	simFolder.add(simSettings, "showCollisionPolygons").name("Show Collision");

	// Collision test folder
	const collisionTests = {
		"T-bone collision"() {
			// Place two tankers on collision course
			const tankerA = vehicles[2].vehicle;
			const tankerB = vehicles[1].vehicle;

			tankerA.x = 75500;
			tankerA.y = 43000;
			tankerA.heading = 0; // heading east
			tankerA.speed = 7;
			tankerA.drift = 0;
			tankerA.angularVelocity = 0;

			// Frigate comes from north, perpendicular
			tankerB.x = 75700;
			tankerB.y = 42800;
			tankerB.heading = Math.PI / 2; // heading south
			tankerB.speed = 13;
			tankerB.drift = 0;
			tankerB.angularVelocity = 0;

			activeIndex = 2;
			mode.freeCamera = false;
			mode.cameraFollow = true;
			cam.zoom = 0.15;
			rebuildVehicleFolder();
		},
		"Head-on collision"() {
			const a = vehicles[2].vehicle; // tanker
			const b = vehicles[1].vehicle; // frigate

			a.x = 75300;
			a.y = 43000;
			a.heading = 0; // east
			a.speed = 7;
			a.drift = 0;
			a.angularVelocity = 0;

			b.x = 75800;
			b.y = 43000;
			b.heading = Math.PI; // west
			b.speed = 13;
			b.drift = 0;
			b.angularVelocity = 0;

			activeIndex = 2;
			mode.freeCamera = false;
			mode.cameraFollow = true;
			cam.zoom = 0.1;
			rebuildVehicleFolder();
		},
		"Speedboat rams tanker"() {
			const boat = vehicles[0].vehicle;
			const tanker = vehicles[2].vehicle;

			tanker.x = 75500;
			tanker.y = 43000;
			tanker.heading = 0;
			tanker.speed = 4;
			tanker.drift = 0;
			tanker.angularVelocity = 0;

			// Speedboat approaches from port bow at angle
			boat.x = 75350;
			boat.y = 42900;
			boat.heading = Math.PI / 6; // heading ~30deg south-east
			boat.speed = 26;
			boat.drift = 0;
			boat.angularVelocity = 0;

			activeIndex = 0;
			mode.freeCamera = false;
			mode.cameraFollow = true;
			cam.zoom = 0.15;
			rebuildVehicleFolder();
		},
		"Destroy active vehicle"() {
			const pv = vehicles[activeIndex];
			if (pv.hp <= 0) return;
			pv.hp = 0;
			pv.respawnTimer = RESPAWN_TIME;
			effectManager.spawnExplosion(pv.vehicle.x, pv.vehicle.y);
		},
		"Spawn explosion (no kill)"() {
			const v = activeVehicle();
			effectManager.spawnExplosion(v.x, v.y);
		},
	};

	const collisionFolder = gui.addFolder("Collision Tests");
	collisionFolder.add(collisionTests, "T-bone collision");
	collisionFolder.add(collisionTests, "Head-on collision");
	collisionFolder.add(collisionTests, "Speedboat rams tanker");
	collisionFolder.add(collisionTests, "Destroy active vehicle");
	collisionFolder.add(collisionTests, "Spawn explosion (no kill)");

	// Presets
	const presets = {
		"Full Map"() {
			mode.freeCamera = true;
			mode.cameraFollow = false;
			cam.worldX = MAP.width / 2;
			cam.worldY = MAP.height / 2;
			cam.zoom = 0.012;
		},
		Strait() {
			mode.freeCamera = true;
			mode.cameraFollow = false;
			cam.worldX = MAP.center.x;
			cam.worldY = MAP.center.y;
			cam.zoom = 0.04;
		},
		"Follow Vehicle"() {
			mode.freeCamera = false;
			mode.cameraFollow = true;
			cam.zoom = 0.3;
		},
		"Reset All"() {
			for (let i = 0; i < vehicles.length; i++) {
				const pv = vehicles[i];
				pv.vehicle.x = SPAWN_POSITIONS[i][0];
				pv.vehicle.y = SPAWN_POSITIONS[i][1];
				pv.vehicle.heading = Math.PI;
				pv.vehicle.speed = 0;
				pv.vehicle.drift = 0;
				pv.vehicle.angularVelocity = 0;
				pv.hp = 100;
				pv.respawnTimer = 0;
			}
			mode.freeCamera = false;
			mode.cameraFollow = true;
			cam.zoom = 0.3;
		},
	};

	const presetsFolder = gui.addFolder("Presets");
	presetsFolder.add(presets, "Full Map");
	presetsFolder.add(presets, "Strait");
	presetsFolder.add(presets, "Follow Vehicle");
	presetsFolder.add(presets, "Reset All");

	// Layers
	const layersFolder = gui.addFolder("Layers");
	layersFolder.add(layers, "showDepthZones").name("Depth Zones");
	layersFolder.add(layers, "showShippingLanes").name("Shipping Lanes");
	layersFolder.add(layers, "showHazards").name("Hazards");
	layersFolder.add(layers, "showSpawnPoints").name("Spawn Points");
	layersFolder.add(layers, "showTerrain").name("Terrain");
	layersFolder.add(layers, "showGrid").name("Grid");
	layersFolder
		.add(layers, "gridSize", {
			"10 units": 10,
			"100 units": 100,
			"1000 units": 1000,
		})
		.name("Grid Size");

	// ---- Mouse controls ----
	const canvas = app.canvas;

	canvas.addEventListener("mousedown", (e: MouseEvent) => {
		if (e.button === 0 || e.button === 1) {
			isDragging = true;
			lastMouseX = e.clientX;
			lastMouseY = e.clientY;
		}
	});

	canvas.addEventListener("mousemove", (e: MouseEvent) => {
		mouseScreenX = e.clientX;
		mouseScreenY = e.clientY;
		if (isDragging && mode.freeCamera) {
			cam.worldX -= (e.clientX - lastMouseX) / cam.zoom;
			cam.worldY -= (e.clientY - lastMouseY) / cam.zoom;
		}
		lastMouseX = e.clientX;
		lastMouseY = e.clientY;
	});

	canvas.addEventListener("mouseup", () => {
		isDragging = false;
	});
	canvas.addEventListener("mouseleave", () => {
		isDragging = false;
	});

	canvas.addEventListener(
		"wheel",
		(e: WheelEvent) => {
			e.preventDefault();
			cam.zoom = Math.max(
				0.02,
				Math.min(10, cam.zoom * (e.deltaY > 0 ? 0.9 : 1.1)),
			);
		},
		{ passive: false },
	);

	// ---- Keyboard ----
	window.addEventListener("keydown", (e: KeyboardEvent) => {
		keysDown.add(e.key.toLowerCase());

		// Tab: toggle free camera
		if (e.key === "Tab") {
			e.preventDefault();
			mode.freeCamera = !mode.freeCamera;
			mode.cameraFollow = !mode.freeCamera;
		}

		// 1-6: switch active vehicle
		const digit = Number.parseInt(e.key);
		if (digit >= 1 && digit <= 9 && digit - 1 < vehicles.length) {
			activeIndex = digit - 1;
			mode.freeCamera = false;
			mode.cameraFollow = true;
			rebuildVehicleFolder();
		}
	});

	window.addEventListener("keyup", (e: KeyboardEvent) => {
		keysDown.delete(e.key.toLowerCase());
	});

	// ---- Resize ----
	window.addEventListener("resize", () => {
		cam.screenWidth = window.innerWidth;
		cam.screenHeight = window.innerHeight;
		coordText.y = window.innerHeight - 50;
		boatText.y = window.innerHeight - 30;
	});

	// ---- Render loop ----
	app.ticker.add(() => {
		const rawDt = app.ticker.deltaMS / 1000;
		const dt = rawDt * simSettings.timeScale;

		// -- Input --
		const input: VehicleInput = { throttle: 0, rudder: 0 };
		if (!mode.freeCamera) {
			if (keysDown.has("w") || keysDown.has("arrowup")) input.throttle = 1;
			if (keysDown.has("s") || keysDown.has("arrowdown")) input.throttle = -1;
			if (keysDown.has("a") || keysDown.has("arrowleft")) input.rudder = -1;
			if (keysDown.has("d") || keysDown.has("arrowright")) input.rudder = 1;
		} else {
			const panSpeed = 500 / cam.zoom;
			if (keysDown.has("a") || keysDown.has("arrowleft")) {
				cam.worldX -= panSpeed * rawDt;
			}
			if (keysDown.has("d") || keysDown.has("arrowright")) {
				cam.worldX += panSpeed * rawDt;
			}
			if (keysDown.has("w") || keysDown.has("arrowup")) {
				cam.worldY -= panSpeed * rawDt;
			}
			if (keysDown.has("s") || keysDown.has("arrowdown")) {
				cam.worldY += panSpeed * rawDt;
			}
		}

		// -- Respawn dead vehicles --
		for (let i = 0; i < vehicles.length; i++) {
			const pv = vehicles[i];
			if (pv.hp <= 0) {
				pv.respawnTimer -= dt;
				if (pv.respawnTimer <= 0) {
					pv.hp = 100;
					pv.respawnTimer = 0;
					pv.vehicle.x = SPAWN_POSITIONS[i][0];
					pv.vehicle.y = SPAWN_POSITIONS[i][1];
					pv.vehicle.heading = Math.PI;
					pv.vehicle.speed = 0;
					pv.vehicle.drift = 0;
					pv.vehicle.angularVelocity = 0;
				}
			}
		}

		// -- Update all alive vehicles (save positions for collision rollback) --
		const prevPositions: { x: number; y: number }[] = [];
		for (const pv of vehicles) {
			prevPositions.push({ x: pv.vehicle.x, y: pv.vehicle.y });
		}

		const aliveVehicles: NavalVehicle[] = [];
		for (let i = 0; i < vehicles.length; i++) {
			const pv = vehicles[i];
			if (pv.hp <= 0) continue;
			if (i === activeIndex) {
				updateVehicle(pv.vehicle, input, dt);
			} else {
				updateVehicle(pv.vehicle, { throttle: 0, rudder: 0 }, dt);
			}
			aliveVehicles.push(pv.vehicle);
		}

		// -- Collisions (alive vehicles only) --
		for (let i = 0; i < vehicles.length; i++) {
			if (vehicles[i].hp <= 0) continue;
			resolveTerrainCollision(
				vehicles[i].vehicle,
				prevPositions[i].x,
				prevPositions[i].y,
			);
		}
		resolveVehicleCollisions(aliveVehicles);

		// -- Camera follow --
		if (mode.cameraFollow) {
			const v = activeVehicle();
			const followSpeed = 5;
			const altOffset = v.airborne ? 30 : 0;
			cam.worldX += (v.x - altOffset - cam.worldX) * followSpeed * rawDt;
			cam.worldY += (v.y - altOffset - cam.worldY) * followSpeed * rawDt;
		}

		// -- Redraw map (always: water shader is animated) --
		elapsedTime += rawDt;
		renderMap(mapContainer, cam, layers, elapsedTime);

		// -- Update and draw effects --
		const entityStates = vehicles.map((pv, i) => ({
			id: i,
			vehicleType: pv.vehicle.vehicleType,
			faction: "civilian",
			x: pv.vehicle.x,
			y: pv.vehicle.y,
			heading: pv.vehicle.heading,
			speed: pv.vehicle.speed,
			drift: pv.vehicle.drift,
			hp: pv.hp,
			angularVelocity: pv.vehicle.angularVelocity,
		}));
		effectManager.update(entityStates, dt);
		effectManager.draw(cam);

		// -- Draw alive vehicles --
		vehicleGfx.clear();
		for (let i = 0; i < vehicles.length; i++) {
			const pv = vehicles[i];
			if (pv.hp <= 0) continue;
			renderVehicle(vehicleGfx, cam, pv.vehicle, pv.color);

			// Debug: draw collision polygon wireframe
			if (simSettings.showCollisionPolygons) {
				const verts = COLLISION_POLYGONS[pv.vehicle.vehicleType];
				if (verts) {
					const cos = Math.cos(pv.vehicle.heading);
					const sin = Math.sin(pv.vehicle.heading);
					const sz = pv.vehicle.size;
					const screenPts = verts.map(([lx, ly]) => {
						const wx = pv.vehicle.x + (lx * cos - ly * sin) * sz;
						const wy = pv.vehicle.y + (lx * sin + ly * cos) * sz;
						return worldToScreen(cam, wx, wy);
					});
					vehicleGfx.moveTo(screenPts[0].x, screenPts[0].y);
					for (let k = 1; k < screenPts.length; k++) {
						vehicleGfx.lineTo(screenPts[k].x, screenPts[k].y);
					}
					vehicleGfx.closePath();
					vehicleGfx.stroke({
						color: 0x00ff00,
						width: 1,
						alpha: 0.5,
					});
				}
			}
		}

		// -- HUD --
		const world = screenToWorld(cam, mouseScreenX, mouseScreenY);
		const v = activeVehicle();
		const label = vehicles[activeIndex].label;
		const elev = getElevation(v.x, v.y);
		const slope = getSlopeAlongHeading(v.x, v.y, v.heading);
		const omega = v.angularVelocity;
		const pv = vehicles[activeIndex];
		const hpStr =
			pv.hp <= 0 ? `DEAD (${pv.respawnTimer.toFixed(1)}s)` : `HP: ${pv.hp}`;
		coordText.text = `Cursor: (${Math.round(world.x)}, ${Math.round(world.y)})  Elev: ${getElevation(world.x, world.y).toFixed(0)}  Zoom: ${cam.zoom.toFixed(3)}  ${mode.freeCamera ? "[FREE CAM]" : "[FOLLOW]"}  Time: ${simSettings.timeScale.toFixed(1)}x`;
		boatText.text = `${label}: ${hpStr}  Speed: ${v.speed.toFixed(1)}  Drift: ${v.drift.toFixed(2)}  Heading: ${((v.heading * 180) / Math.PI).toFixed(0)}°  AngVel: ${omega.toFixed(3)}  [1-6]`;
	});

	console.log(
		"Hormuz playground — WASD to drive, 1-6 to switch vehicle, Tab for free camera, scroll to zoom",
	);
}

init();
