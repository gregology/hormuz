import {
	type EditorState, type EditorMode, type EditableZone, type EditableSpawn, type EditableRock,
	LAYERS, ALL_BEHAVIORS,
} from "./editor-state";

export interface EditorUI {
	refreshAll(): void;
	refreshLayers(): void;
	refreshItemList(): void;
	refreshProperties(): void;
	refreshToolbar(): void;
	refreshStatus(): void;
	refreshCoords(wx: number, wy: number): void;
}

export function buildUI(
	editor: EditorState,
	onSave: () => void,
	onRebuild: () => void,
): EditorUI {
	const zoneListEl = document.getElementById("zone-list")!;
	const propertiesEl = document.getElementById("properties")!;
	const statusMode = document.getElementById("status-mode")!;
	const statusCoords = document.getElementById("status-coords")!;
	const statusHint = document.getElementById("status-hint")!;
	const sidebarTitle = document.querySelector("#sidebar h2")!;

	// Toolbar buttons
	const toolBtns = document.querySelectorAll<HTMLButtonElement>(".tool-btn[data-mode]");
	for (const btn of toolBtns) {
		btn.addEventListener("click", () => {
			editor.setMode(btn.dataset.mode as EditorMode);
			onRebuild();
			ui.refreshToolbar();
			ui.refreshStatus();
		});
	}

	document.getElementById("btn-delete")!.addEventListener("click", () => {
		editor.deleteSelected();
		onRebuild();
		ui.refreshItemList();
		ui.refreshProperties();
		ui.refreshStatus();
	});

	document.getElementById("btn-save")!.addEventListener("click", onSave);

	// Build layer selector in sidebar
	const layerListEl = document.createElement("div");
	layerListEl.id = "layer-list";
	layerListEl.style.cssText = "padding: 4px 8px; border-bottom: 1px solid #1f2937; max-height: 260px; overflow-y: auto;";
	zoneListEl.parentElement!.insertBefore(layerListEl, zoneListEl);

	function rebuildAndRefresh(): void {
		onRebuild();
		ui.refreshItemList();
		ui.refreshProperties();
		ui.refreshStatus();
	}

	const ui: EditorUI = {
		refreshAll() {
			ui.refreshLayers();
			ui.refreshItemList();
			ui.refreshProperties();
			ui.refreshToolbar();
			ui.refreshStatus();
		},

		refreshLayers() {
			layerListEl.innerHTML = "";
			let currentCategory = "";
			for (const layer of LAYERS) {
				if (layer.category !== currentCategory) {
					currentCategory = layer.category;
					const cat = document.createElement("div");
					cat.style.cssText = "font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:6px 6px 2px;margin-top:4px;";
					cat.textContent = currentCategory;
					layerListEl.appendChild(cat);
				}
				const item = document.createElement("div");
				item.className = "zone-item" + (layer.key === editor.activeLayerKey ? " selected" : "");
				const nameSpan = document.createElement("span");
				nameSpan.className = "name";
				nameSpan.textContent = layer.label;
				const countSpan = document.createElement("span");
				countSpan.className = "vertex-count";
				const items = editor.getItems();
				countSpan.textContent = layer.kind === "polyline" ? `${items.length}pt` : `${items.length}`;
				item.appendChild(nameSpan);
				item.appendChild(countSpan);
				item.addEventListener("click", () => {
					editor.setActiveLayer(layer.key);
					onRebuild();
					ui.refreshAll();
				});
				layerListEl.appendChild(item);
			}
			sidebarTitle.textContent = editor.activeLayer.label;
		},

		refreshItemList() {
			zoneListEl.innerHTML = "";
			const layer = editor.activeLayer;
			const items = editor.getItems();

			if (layer.kind === "polyline") {
				// Single item — just show vertex count
				const item = document.createElement("div");
				item.className = "zone-item" + (editor.selectedIndex === 0 ? " selected" : "");
				item.innerHTML = `<span class="name">${layer.label}</span><span class="vertex-count">${items.length}pt</span>`;
				item.addEventListener("click", () => { editor.selectItem(0); rebuildAndRefresh(); });
				zoneListEl.appendChild(item);
				return;
			}

			for (let i = 0; i < items.length; i++) {
				const item = document.createElement("div");
				item.className = "zone-item" + (i === editor.selectedIndex ? " selected" : "");

				const nameSpan = document.createElement("span");
				nameSpan.className = "name";
				if (layer.key === "exclusionZones") {
					nameSpan.textContent = (items[i] as EditableZone).name;
				} else if (layer.kind === "point") {
					if (layer.key.startsWith("dest_")) {
						const pt = items[i] as [number, number];
						nameSpan.textContent = `${layer.label} (${pt[0]}, ${pt[1]})`;
					} else if (layer.key === "rocks") {
						const r = items[i] as EditableRock;
						nameSpan.textContent = r.label || `Rock ${i + 1}`;
					} else {
						nameSpan.textContent = (items[i] as EditableSpawn).label;
					}
				} else {
					const verts = items[i] as [number, number][];
					nameSpan.textContent = `Polygon ${i + 1}`;
					const countSpan = document.createElement("span");
					countSpan.className = "vertex-count";
					countSpan.textContent = `${verts.length}v`;
					item.appendChild(nameSpan);
					item.appendChild(countSpan);
					item.addEventListener("click", () => { editor.selectItem(i); rebuildAndRefresh(); });
					zoneListEl.appendChild(item);
					continue;
				}

				item.appendChild(nameSpan);
				item.addEventListener("click", () => { editor.selectItem(i); rebuildAndRefresh(); });
				zoneListEl.appendChild(item);
			}
		},

		refreshProperties() {
			propertiesEl.innerHTML = "";
			if (editor.selectedIndex === null) {
				propertiesEl.classList.add("hidden");
				return;
			}
			propertiesEl.classList.remove("hidden");

			const layer = editor.activeLayer;
			const items = editor.getItems();
			const item = items[editor.selectedIndex];

			// Add h3 header
			const h3 = document.createElement("h3");
			h3.textContent = "Properties";
			h3.style.cssText = "font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;padding:0 0 4px;margin:0;";
			propertiesEl.appendChild(h3);

			if (layer.key === "exclusionZones") {
				const zone = item as EditableZone;
				addTextInput("Name", zone.name, (v) => { zone.name = v; ui.refreshItemList(); });
				addBehaviorCheckboxes(zone.behaviors);
			} else if (editor.getActiveAreaWithRadius()) {
				const area = editor.getActiveAreaWithRadius()!;
				addNumberInput("Radius", area.radius, (v) => { area.radius = v; onRebuild(); });
			} else if (layer.key === "escortZone") {
				addNumberInput("West X", editor.data.escortZone.west, (v) => { editor.data.escortZone.west = v; });
				addNumberInput("East X", editor.data.escortZone.east, (v) => { editor.data.escortZone.east = v; });
			} else if (layer.kind === "point") {
				if (layer.key === "rocks") {
					const rock = item as EditableRock;
					addTextInput("Label", rock.label, (v) => { rock.label = v; ui.refreshItemList(); });
					addNumberInput("Radius", rock.radius, (v) => { rock.radius = v; onRebuild(); });
				} else {
					const spawn = item as EditableSpawn;
					addTextInput("Label", spawn.label, (v) => { spawn.label = v; ui.refreshItemList(); });
					addNumberInput("Heading (rad)", spawn.heading, (v) => { spawn.heading = v; onRebuild(); });
					addNumberInput("Scatter Radius", spawn.scatterRadius, (v) => { spawn.scatterRadius = v; onRebuild(); });
					addTextInput("Group", spawn.group, (v) => { spawn.group = v; });
				}
			}

			function addTextInput(labelText: string, value: string, onChange: (v: string) => void): void {
				const label = document.createElement("label");
				label.textContent = labelText;
				const input = document.createElement("input");
				input.type = "text";
				input.value = value;
				input.addEventListener("input", () => onChange(input.value));
				propertiesEl.appendChild(label);
				propertiesEl.appendChild(input);
			}

			function addNumberInput(labelText: string, value: number, onChange: (v: number) => void): void {
				const label = document.createElement("label");
				label.textContent = labelText;
				const input = document.createElement("input");
				input.type = "text";
				input.value = String(Math.round(value * 100000) / 100000);
				input.addEventListener("input", () => {
					const v = parseFloat(input.value);
					if (!isNaN(v)) onChange(v);
				});
				propertiesEl.appendChild(label);
				propertiesEl.appendChild(input);
			}

			function addBehaviorCheckboxes(behaviors: string[]): void {
				const label = document.createElement("label");
				label.textContent = "Behaviors";
				propertiesEl.appendChild(label);
				const list = document.createElement("div");
				list.id = "behavior-list";
				for (const behavior of ALL_BEHAVIORS) {
					const row = document.createElement("div");
					row.className = "behavior-row";
					const cb = document.createElement("input");
					cb.type = "checkbox";
					cb.checked = behaviors.includes(behavior);
					cb.addEventListener("change", () => {
						const idx = behaviors.indexOf(behavior);
						if (idx >= 0) behaviors.splice(idx, 1);
						else behaviors.push(behavior);
					});
					const span = document.createElement("span");
					span.textContent = behavior;
					row.appendChild(cb);
					row.appendChild(span);
					list.appendChild(row);
				}
				propertiesEl.appendChild(list);
			}
		},

		refreshToolbar() {
			for (const btn of toolBtns) {
				btn.classList.toggle("active", btn.dataset.mode === editor.mode);
			}
		},

		refreshStatus() {
			const layer = editor.activeLayer;
			const modeLabel = editor.mode === "draw" ? "Draw" : "Select";
			statusMode.textContent = `Mode: ${modeLabel} | ${layer.label}`;

			if (editor.mode === "draw") {
				if (layer.kind === "point") {
					statusHint.textContent = "Click to place a point";
				} else {
					const n = editor.drawingVertices.length;
					const minPts = layer.kind === "polygon" ? 3 : 2;
					statusHint.textContent = n < minPts
						? `${n} vertices — need at least ${minPts}`
						: `${n} vertices — double-click or Enter to finish, Esc to cancel`;
				}
			} else {
				if (editor.selectedIndex !== null) {
					statusHint.textContent = layer.kind === "point"
						? "Drag to move • Delete to remove"
						: "Drag vertices to edit • Double-click edge to add vertex • Delete to remove";
				} else {
					statusHint.textContent = `Click to select a ${layer.kind}`;
				}
			}
		},

		refreshCoords(wx: number, wy: number) {
			statusCoords.textContent = `${Math.round(wx)}, ${Math.round(wy)}`;
		},
	};

	return ui;
}
