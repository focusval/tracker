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
    id: "crop-ellipse-fill",
    type: "fill",
    source: "crop-ellipse",
    filter: ["==", ["get", "role"], "fill"],
    paint: { "fill-color": "#e5a13c", "fill-opacity": 0.08 },
  });
  map.addLayer({
    id: "crop-grid",
    type: "line",
    source: "crop-ellipse",
    filter: ["==", ["get", "role"], "grid"],
    paint: { "line-color": "#e5a13c", "line-width": 1, "line-opacity": 0.45 },
  });
  map.addLayer({
    id: "crop-ellipse-line",
    type: "line",
    source: "crop-ellipse",
    filter: ["==", ["get", "role"], "fill"],
    paint: { "line-color": "#e5a13c", "line-width": 2, "line-dasharray": [2, 2] },
  });
  // лінії прив'язки по точках (сплат → карта)
  map.addSource("align-lines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "align-lines",
    type: "line",
    source: "align-lines",
    paint: { "line-color": "#43c0d0", "line-width": 2, "line-dasharray": [1, 1] },
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
    let buf;
    try {
      buf = await fetchWithProgress(sc.file + "?v=" + (sc.v || 0), (f) => {
        showProgress(`${tag} · ${fmtPct(f)}`, f);
      });
    } catch (err) {
      // Pages міг ще не редеплоїтись після коміту — в режимі редагування
      // забираємо файл прямо з репозиторію через API
      if (!state.client) throw err;
      buf = await state.client.getRawFile(sc.file, (f) => {
        showProgress(`${tag} (з репозиторію) · ${fmtPct(f)}`, f);
      });
    }
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
  const hideAll = $("#hideAllBtn");
  if (hideAll){
    hideAll.hidden = !state.scenes.length;
    hideAll.textContent = state.scenes.some((s) => s.visible) ? "🙈 Сховати всі" : "👁 Показати всі";
  }
  if (!state.scenes.length){
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Локацій поки немає.";
    box.appendChild(p);
    return;
  }
  for (const sc of state.scenes){
    const row = document.createElement("div");
    row.className = "scene-row" + (sc.visible ? "" : " off") + (state.selectedId === sc.id ? " sel" : "");
    const r = rt(sc.id);
    const status = !sc.visible ? "схована" : r.loaded ? fmtInt(sc.count) + " сплатів" : r.loading ? "вантажиться…" : "не завантажена";
    row.innerHTML = `<input type="checkbox" class="scene-vis" title="Показувати сцену на карті">` +
      `<button type="button" class="scene-open"><span class="scene-name"></span><span class="scene-meta"></span></button>`;
    row.querySelector(".scene-name").textContent = sc.name;
    row.querySelector(".scene-meta").textContent = status;
    const chk = row.querySelector(".scene-vis");
    chk.checked = sc.visible;
    chk.addEventListener("change", () => setSceneVisible(sc, chk.checked));
    row.querySelector(".scene-open").addEventListener("click", () => {
      flyToScene(sc);
      if (state.editing && window.__edit) window.__edit.selectScene(sc.id);
    });
    box.appendChild(row);
  }
}

// У режимі редагування зміна видимості — це незбережена зміна конфігурації:
// ставимо крапку на «Зберегти в архів» і синхронізуємо панель калібрування.
function noteVisibilityEdited(){
  if (!state.editing) return;
  state.dirty = true;
  const save = $("#saveBtn");
  if (save) save.classList.add("dirty");
  const sel = state.scenes.find((s) => s.id === state.selectedId);
  if (sel){
    const chk = $("#visChk");
    if (chk) chk.checked = sel.visible;
  }
}

// Перемикання видимості сцени галочкою у списку. Схована сцена не рендериться
// і не вантажиться (економія пам'яті телефона); показана — довантажується.
export function setSceneVisible(sc, v){
  sc.visible = v;
  layer.setVisible(sc.id, v);
  noteVisibilityEdited();
  if (v && !rt(sc.id).loaded) loadScene(sc).catch(toastError);
  updateStats();
  renderSceneList();
}

// «Сховати всі / Показати всі»: показ довантажує сцени по черзі (як при
// старті), щоб не задушити пам'ять телефона паралельними завантаженнями.
async function toggleAllScenes(show){
  for (const sc of state.scenes){
    sc.visible = show;
    layer.setVisible(sc.id, show);
  }
  noteVisibilityEdited();
  updateStats();
  renderSceneList();
  if (show){
    for (const sc of state.scenes){
      if (!rt(sc.id).loaded){
        try {
          await loadScene(sc);
        } catch (err) {
          toastError(new Error(`«${sc.name}»: ${err.message}`));
        }
      }
    }
  }
}

// ── нижня панель і кнопка редагування ──

// шторка: тап по смужці перемикає, свайп угору/вниз — відкриває/закриває
{
  const grip = $("#sheetGrip");
  let y0 = null;
  grip.addEventListener("pointerdown", (e) => { y0 = e.clientY; });
  grip.addEventListener("pointerup", (e) => {
    const dy = y0 == null ? 0 : e.clientY - y0;
    y0 = null;
    if (dy < -25) $("#sheet").classList.add("open");
    else if (dy > 25) $("#sheet").classList.remove("open");
    else $("#sheet").classList.toggle("open");
  });
}

$("#hideAllBtn").addEventListener("click", () => {
  const anyVisible = state.scenes.some((s) => s.visible);
  toggleAllScenes(!anyVisible).catch(toastError);
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
