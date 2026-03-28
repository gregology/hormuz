import GUI from "lil-gui";
import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { MAP } from "../../client/src/map/data";
import {
	getElevation,
	getSlopeAlongHeading,
} from "../../client/src/map/heightmap";
import {
	type Camera,
	createCamera,
	screenToWorld,
} from "../../client/src/render/camera";
import { COLORS } from "../../client/src/render/colors";
import {
	DEFAULT_LAYERS,
	type MapLayers,
	renderMap,
} from "../../client/src/render/map-renderer";
import { renderVehicle } from "../../client/src/render/vehicle-renderer";
import {
	type NavalVehicle,
	type VehicleInput,
	createFrigate,
	createOilTanker,
	createSpeedboat,
	updateVehicle,
} from "../../client/src/vehicles/physics";

const FACTION_COLORS: Record<string, number> = {
	speedboat: COLORS.spawnIran,
	frigate: COLORS.spawnUS,
	tanker: COLORS.spawnTanker,
};

interface PlayableVehicle {
	key: string;
	label: string;
	vehicle: NavalVehicle;
	color: number;
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
	const vehicleGfx = new Graphics();
	app.stage.addChild(mapContainer);
	app.stage.addChild(vehicleGfx);

	// ---- Map layers ----
	const layers: MapLayers = { ...DEFAULT_LAYERS };

	// ---- Vehicles ----
	const vehicles: PlayableVehicle[] = [
		{
			key: "speedboat",
			label: "Speedboat",
			vehicle: createSpeedboat(85900, 42500),
			color: FACTION_COLORS.speedboat,
		},
		{
			key: "frigate",
			label: "Frigate",
			vehicle: createFrigate(85400, 43000),
			color: FACTION_COLORS.frigate,
		},
		{
			key: "tanker",
			label: "Oil Tanker",
			vehicle: createOilTanker(83900, 42700),
			color: FACTION_COLORS.tanker,
		},
	];

	// Set initial headings (all heading west through the strait)
	vehicles[0].vehicle.heading = Math.PI;
	vehicles[1].vehicle.heading = Math.PI;
	vehicles[2].vehicle.heading = Math.PI;

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
		vehicleFolder.add(v, "size", 2, 300).name("Visual Size");
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
			vehicles[0].vehicle.x = 85900;
			vehicles[0].vehicle.y = 42500;
			vehicles[0].vehicle.heading = Math.PI;
			vehicles[0].vehicle.speed = 0;
			vehicles[1].vehicle.x = 85400;
			vehicles[1].vehicle.y = 43000;
			vehicles[1].vehicle.heading = Math.PI;
			vehicles[1].vehicle.speed = 0;
			vehicles[2].vehicle.x = 83900;
			vehicles[2].vehicle.y = 42700;
			vehicles[2].vehicle.heading = Math.PI;
			vehicles[2].vehicle.speed = 0;
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

		// 1/2/3: switch active vehicle
		if (e.key === "1" || e.key === "2" || e.key === "3") {
			const idx = Number.parseInt(e.key) - 1;
			if (idx < vehicles.length) {
				activeIndex = idx;
				mode.freeCamera = false;
				mode.cameraFollow = true;
				rebuildVehicleFolder();
			}
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
		const dt = app.ticker.deltaMS / 1000;

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
				cam.worldX -= panSpeed * dt;
			}
			if (keysDown.has("d") || keysDown.has("arrowright")) {
				cam.worldX += panSpeed * dt;
			}
			if (keysDown.has("w") || keysDown.has("arrowup")) {
				cam.worldY -= panSpeed * dt;
			}
			if (keysDown.has("s") || keysDown.has("arrowdown")) {
				cam.worldY += panSpeed * dt;
			}
		}

		// -- Update active vehicle --
		updateVehicle(activeVehicle(), input, dt);

		// -- Camera follow --
		if (mode.cameraFollow) {
			const v = activeVehicle();
			const followSpeed = 5;
			cam.worldX += (v.x - cam.worldX) * followSpeed * dt;
			cam.worldY += (v.y - cam.worldY) * followSpeed * dt;
		}

		// -- Redraw map (always: water shader is animated) --
		elapsedTime += dt;
		renderMap(mapContainer, cam, layers, elapsedTime);

		// -- Draw all vehicles --
		vehicleGfx.clear();
		for (let i = 0; i < vehicles.length; i++) {
			const pv = vehicles[i];
			renderVehicle(vehicleGfx, cam, pv.vehicle, pv.color);
		}

		// -- HUD --
		const world = screenToWorld(cam, mouseScreenX, mouseScreenY);
		const v = activeVehicle();
		const label = vehicles[activeIndex].label;
		const elev = getElevation(v.x, v.y);
		const slope = getSlopeAlongHeading(v.x, v.y, v.heading);
		coordText.text = `Cursor: (${Math.round(world.x)}, ${Math.round(world.y)})  Elev: ${getElevation(world.x, world.y).toFixed(0)}  Zoom: ${cam.zoom.toFixed(3)}  ${mode.freeCamera ? "[FREE CAM]" : "[FOLLOW]"}`;
		boatText.text = `${label}: Speed: ${v.speed.toFixed(1)}  Drift: ${v.drift.toFixed(2)}  Heading: ${((v.heading * 180) / Math.PI).toFixed(0)}°  Elev: ${elev.toFixed(0)}  Slope: ${slope.toFixed(3)}  [1/2/3]`;
	});

	console.log(
		"Hormuz playground — WASD to drive, 1/2/3 to switch vehicle, Tab for free camera, scroll to zoom",
	);
}

init();
