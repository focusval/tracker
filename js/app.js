// Сєвєро·3D — головний модуль: карта, завантаження сцен, режим перегляду.
// Режим редагування підвантажується окремо (js/edit.js) лише за потреби.

import { SplatLayer } from "./renderer.js";
import { parseSplatFile } from "./formats.js";
import { state, rt, START, normalizeScenes, sceneParams } from "./state.js";
import { $, toast, toastError, showProgress, hideProgress, fetchWithProgress, fmtInt, fmtMB, fmtPct } from "./ui.js";

const ESRI_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

export const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {
      esri: {
        type: "raster",
        tiles: [ESRI_TILES],
        tileSize: 256,
        maxzoom: 19,
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
      },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#10151a" } },
      { id: "esri", type: "raster", source: "esri" },
    ],
  },
  center: START.center,
  zoom: START.zoom,
  pitch: START.pitch,
  maxPitch: 70,
  attributionControl: { compact: true },
});

export const layer = new SplatLayer();
layer.onError = (msg) => toast(msg, "error", 0);

map.on("load", () => {
  map.addLayer(layer);
  // контур еліпса обрізки (оновлюється в режимі редагування)
  map.addSource("crop-ellipse", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "crop-ellipse-line",
    type: "line",
    source: "crop-ellipse",
    paint: { "line-color": "#e5a13c", "line-width": 2, "line-dasharray": [2, 2] },
  });
  loadArchive().catch(toastError);
});

map.on("error", (e) => {
  // помилки тайлів не критичні; показуємо лише перший раз
  if (e && e.error && !map._tileErrShown){
    map._tileErrShown = true;
    console.warn("Map error:", e.error);
  }
});

// ── завантаження архіву ──

async function loadArchive(){
  let json = {};
  try {
    const res = await fetch("scenes.json?ts=" + Date.now(), { cache: "no-store" });
    if (res.ok) json = await res.json();
    else if (res.status !== 404) toast("Не вдалося прочитати scenes.json (HTTP " + res.status + ")", "error");
  } catch (err) {
    toast("Не вдалося прочитати scenes.json: " + err.message, "error");
  }
  state.scenes = normalizeScenes(json);
  renderSceneList();
  updateStats();
  const toLoad = state.scenes.filter((s) => s.visible); // сховані сцени не вантажимо (пам'ять!)
  let i = 0;
  for (const sc of toLoad){
    i++;
    try {
      await loadScene(sc, `Сцена ${i} з ${toLoad.length}`);
    } catch (err) {
      toastError(new Error(`«${sc.name}»: ${err.message}`));
    }
  }
  hideProgress();
  if (!state.scenes.length)
    toast("Архів поки порожній. Увімкни режим редагування, щоб додати перший скан.", "info", 8000);
}

// Вантажить .splat сцени з repo (через Pages) і додає в рендерер.
export async function loadScene(sc, label){
  const r = rt(sc.id);
  if (r.loaded || r.loading) return;
  r.loading = true;
  const tag = label || `«${sc.name}»`;
  try {
    showProgress(`${tag} · 0%`, 0);
    const buf = await fetchWithProgress(sc.file + "?v=" + (sc.v || 0), (f) => {
      showProgress(`${tag} · ${fmtPct(f)}`, f);
    });
    const data = parseSplatFile(buf); // без центрування: файл у репо вже центрований
    sc.count = data.count;
    layer.addScene(sc.id, data, sceneParams(sc), sc.visible, sc.crop);
    r.loaded = true;
  } finally {
    r.loading = false;
    hideProgress();
    updateStats();
    renderSceneList();
  }
}

// ── режим перегляду: список локацій, лічильники ──

export function flyToScene(sc){
  map.flyTo({ center: [sc.lng, sc.lat], zoom: 16.5, pitch: START.pitch, duration: 2500, essential: true });
}

export function updateStats(){
  let splats = 0;
  for (const sc of state.scenes){
    if (rt(sc.id).loaded && sc.visible) splats += sc.count;
  }
  $("#statLine").textContent = fmtInt(splats) + " сплатів · " + fmtMB(splats * 32) + " GPU";
}

export function renderSceneList(){
  const box = $("#sceneList");
  box.innerHTML = "";
  if (!state.scenes.length){
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Локацій поки немає.";
    box.appendChild(p);
    return;
  }
  for (const sc of state.scenes){
    const row = document.createElement("button");
    row.type = "button";
    row.className = "scene-row" + (sc.visible ? "" : " off") + (state.selectedId === sc.id ? " sel" : "");
    const r = rt(sc.id);
    const status = !sc.visible ? "схована" : r.loaded ? fmtInt(sc.count) + " сплатів" : r.loading ? "вантажиться…" : "не завантажена";
    row.innerHTML = `<span class="scene-name"></span><span class="scene-meta"></span>`;
    row.querySelector(".scene-name").textContent = sc.name;
    row.querySelector(".scene-meta").textContent = status;
    row.addEventListener("click", () => {
      flyToScene(sc);
      if (state.editing && window.__edit) window.__edit.selectScene(sc.id);
    });
    box.appendChild(row);
  }
}

// ── нижня панель і кнопка редагування ──

$("#sheetGrip").addEventListener("click", () => {
  $("#sheet").classList.toggle("open");
});

$("#editBtn").addEventListener("click", async () => {
  try {
    const mod = await import("./edit.js");
    window.__edit = mod;
    mod.toggleEdit();
  } catch (err) {
    toastError(err);
  }
});
