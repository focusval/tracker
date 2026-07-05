// Режим редагування: токен, додавання сканів, калібрування, обрізка,
// запікання, збереження в репозиторій. Підвантажується динамічно з app.js.

import { map, layer, renderSceneList, updateStats, loadScene } from "./app.js";
import { parsePlyFile, parseSplatFile, writeSplat } from "./formats.js";
import { centerCloud, filterCrop, estimateLevel } from "./gsmath.js";
import { GitHubClient, HARD_LIMIT, probeGitHub } from "./github.js";
import { makeZip } from "./zip.js";
import { state, rt, serializeScenes, sceneParams, detectRepo } from "./state.js";
import { $, toast, toastError, showProgress, hideProgress, fetchWithProgress, fmtInt, fmtMB, fmtPct, downloadText } from "./ui.js";

const LS_TOKEN = "severo3d.token";
let marker = null;

// Стан редагування, що не зберігається у scenes.json: маска стертих гумкою
// сплатів і стек «крок назад». Тримаємо лише для вибраної сцени.
const edits = new Map(); // id -> { mask, history:[], redo:[], eraseMode, align }
function editRec(id){
  let e = edits.get(id);
  if (!e){ e = { mask: null, history: [], redo: [], eraseMode: false, align: null }; edits.set(id, e); }
  return e;
}
const HISTORY_MAX = 60;

// ── вхід/вихід ──

export function toggleEdit(){
  if (state.editing) exitEdit(); else enterEdit();
}

function enterEdit(){
  state.editing = true;
  document.body.classList.add("editing");
  $("#editBtn").textContent = "Готово";
  $("#sheet").classList.add("open");
  layer.onErase = onEraseResult;
  const token = localStorage.getItem(LS_TOKEN);
  if (token){ initClient(token); showTools(); }
  else showTokenForm();
  renderSceneList();
}

function exitEdit(){
  if (state.dirty && !confirm("Є незбережені зміни (позначені крапкою). Вийти без «Зберегти в архів»?")) return;
  state.editing = false;
  document.body.classList.remove("editing");
  $("#editBtn").textContent = "Редагувати";
  deselect();
  renderSceneList();
}

function initClient(token){
  const { owner, repo } = detectRepo();
  state.client = new GitHubClient({ owner, repo, branch: "main", token });
}

function showTokenForm(){
  $("#tokenForm").hidden = false;
  $("#editTools").hidden = true;
}

function showTools(){
  $("#tokenForm").hidden = true;
  $("#editTools").hidden = false;
  updateDirtyDot();
}

function markDirty(){
  state.dirty = true;
  updateDirtyDot();
}

function updateDirtyDot(){
  $("#saveBtn").classList.toggle("dirty", state.dirty);
}

// ── вибір сцени і калібрування ──

export function selectScene(id){
  const sc = state.scenes.find((s) => s.id === id);
  if (!sc) return;
  // при зміні сцени — вимкнути гумку і прив'язку попередньої
  if (state.selectedId && state.selectedId !== id){
    const prev = state.scenes.find((s) => s.id === state.selectedId);
    if (prev){ editRec(prev.id).eraseMode = false; applyEraseMode(prev); }
    if (alignMode) exitAlign();
    clearAlignMarkers();
  }
  state.selectedId = id;
  // кеш байтів тримаємо лише для вибраної сцени (пам'ять телефона)
  for (const [rid, r] of state.runtime)
    if (rid !== id && !r.needsCommit) r.bytesCache = null;
  $("#calib").hidden = false;
  $("#calibTitle").textContent = sc.name;
  $("#nameInput").value = sc.name;
  $("#visChk").checked = sc.visible;
  refreshCalib(sc);
  placeMarker(sc);
  updateEllipse(sc);
  applyEraseMode(sc);
  updateEraseCount(sc);
  updateAlignInfo(sc);
  updateUndoBtn(sc);
  renderSceneList();
  // розкрити шторку і показати панель — інакше на телефоні її не видно
  $("#sheet").classList.add("open");
}

function deselect(){
  const sc = selected();
  if (sc){ editRec(sc.id).eraseMode = false; applyEraseMode(sc); }
  if (alignMode) exitAlign();
  clearAlignMarkers();
  state.selectedId = null;
  $("#calib").hidden = true;
  if (marker){ marker.remove(); marker = null; }
  clearEllipse();
}

function selected(){
  return state.scenes.find((s) => s.id === state.selectedId) || null;
}

function placeMarker(sc){
  if (!marker){
    marker = new maplibregl.Marker({ draggable: true, color: "#e5a13c" });
    marker.setLngLat([sc.lng, sc.lat]).addTo(map);
    marker.on("dragend", () => {
      const s = selected();
      if (!s) return;
      const ll = marker.getLngLat();
      s.lng = ll.lng; s.lat = ll.lat;
      applyParams(s);
    });
  } else {
    marker.setLngLat([sc.lng, sc.lat]);
  }
}

function applyParams(sc){
  layer.setParams(sc.id, sceneParams(sc));
  markDirty();
  updateEllipse(sc);
}

// ── «крок назад / вперед»: знімки стану (параметри + обрізка + маска гумки) ──

function snapshot(sc){
  const e = editRec(sc.id);
  return {
    lng: sc.lng, lat: sc.lat, alt: sc.alt,
    rx: sc.rx, ry: sc.ry, rz: sc.rz, scale: sc.scale,
    crop: { ...sc.crop },
    mask: e.mask ? e.mask.slice() : null,
  };
}

// Фіксуємо стан ПЕРЕД зміною і скидаємо стек «вперед».
// Викликати на початку кожного жесту (один знімок на дію).
function pushHistory(sc){
  const e = editRec(sc.id);
  e.history.push(snapshot(sc));
  if (e.history.length > HISTORY_MAX) e.history.shift();
  e.redo = [];
  updateUndoBtn(sc);
}

// Одна фіксація на жест: беремо знімок на pointerdown/keydown, а не на кожен input.
let gestureOpen = false;
function beginGesture(sc){
  if (gestureOpen || !sc) return;
  gestureOpen = true;
  pushHistory(sc);
}
function endGesture(){ gestureOpen = false; }

function updateUndoBtn(sc){
  const e = sc ? editRec(sc.id) : null;
  const u = $("#undoBtn"), r = $("#redoBtn");
  if (u) u.disabled = !e || e.history.length === 0;
  if (r) r.disabled = !e || e.redo.length === 0;
}

function restore(sc, snap){
  const e = editRec(sc.id);
  sc.lng = snap.lng; sc.lat = snap.lat; sc.alt = snap.alt;
  sc.rx = snap.rx; sc.ry = snap.ry; sc.rz = snap.rz; sc.scale = snap.scale;
  Object.assign(sc.crop, snap.crop);
  e.mask = snap.mask ? snap.mask.slice() : null;
  layer.setEraseMask(sc.id, e.mask);
  layer.setParams(sc.id, sceneParams(sc));
  layer.setCrop(sc.id, sc.crop);
  if (marker) marker.setLngLat([sc.lng, sc.lat]);
  refreshCalib(sc);
  updateEllipse(sc);
  updateEraseCount(sc);
  updateUndoBtn(sc);
  markDirty();
}

function undo(){
  const sc = selected(); if (!sc) return;
  const e = editRec(sc.id);
  if (!e.history.length){ toast("Немає що скасовувати.", "info"); return; }
  e.redo.push(snapshot(sc));
  restore(sc, e.history.pop());
}

function redoStep(){
  const sc = selected(); if (!sc) return;
  const e = editRec(sc.id);
  if (!e.redo.length){ toast("Немає що повторити.", "info"); return; }
  e.history.push(snapshot(sc));
  restore(sc, e.redo.pop());
}

function updateEraseCount(sc){
  const e = editRec(sc.id);
  const total = e.mask ? e.mask.reduce((a, b) => a + b, 0) : 0;
  const el = $("#eraseCount");
  if (el) el.textContent = total ? ("стерто " + fmtInt(total) + " сплатів") : "";
}

// шкала масштабу — логарифмічна: 0..1000 → 0.05×..300×
const SCALE_MIN = 0.05, SCALE_MAX = 300, SCALE_SPAN = SCALE_MAX / SCALE_MIN;
const scaleFromT = (t) => SCALE_MIN * Math.pow(SCALE_SPAN, t / 1000);
const tFromScale = (s) => Math.round(1000 * Math.log(Math.max(SCALE_MIN, Math.min(SCALE_MAX, s)) / SCALE_MIN) / Math.log(SCALE_SPAN));
const wrap180 = (v) => ((v + 180) % 360 + 360) % 360 - 180;

const ranges = [
  { r: "#altRange",  l: "#altVal",  get: (s) => s.alt,   set: (s, v) => { s.alt = v; },   fmt: (v) => v.toFixed(1) + " м" },
  { r: "#rxRange",   l: "#rxVal",   get: (s) => s.rx,    set: (s, v) => { s.rx = v; },    fmt: (v) => v + "°" },
  { r: "#ryRange",   l: "#ryVal",   get: (s) => s.ry,    set: (s, v) => { s.ry = v; },    fmt: (v) => v + "°" },
  { r: "#rzRange",   l: "#rzVal",   get: (s) => s.rz,    set: (s, v) => { s.rz = v; },    fmt: (v) => v + "°" },
];

const cropRanges = [
  { r: "#cropRot",  l: "#cropRotVal",  k: "rot",  fmt: (v) => v + "°" },
  { r: "#cropRx",   l: "#cropRxVal",   k: "rx",   fmt: (v) => v + " м" },
  { r: "#cropRy",   l: "#cropRyVal",   k: "ry",   fmt: (v) => v + " м" },
  { r: "#cropHmin", l: "#cropHminVal", k: "hmin", fmt: (v) => v + " м" },
  { r: "#cropHmax", l: "#cropHmaxVal", k: "hmax", fmt: (v) => v + " м" },
];

function refreshCalib(sc){
  for (const c of ranges){
    $(c.r).value = c.get(sc);
    $(c.l).textContent = c.fmt(c.get(sc));
  }
  $("#scaleRange").value = tFromScale(sc.scale);
  $("#scaleVal").textContent = "×" + sc.scale.toFixed(2);
  $("#cropChk").checked = sc.crop.on;
  $("#cropBody").hidden = !sc.crop.on;
  refreshShapeButtons(sc);
  for (const c of cropRanges){
    $(c.r).value = sc.crop[c.k];
    $(c.l).textContent = c.fmt(sc.crop[c.k]);
  }
}

function wireCalib(){
  for (const c of ranges){
    $(c.r).addEventListener("pointerdown", () => beginGesture(selected()));
    $(c.r).addEventListener("keydown", () => beginGesture(selected()));
    $(c.r).addEventListener("input", () => {
      const sc = selected(); if (!sc) return;
      beginGesture(sc);
      c.set(sc, +$(c.r).value);
      $(c.l).textContent = c.fmt(c.get(sc));
      applyParams(sc);
    });
  }
  $("#scaleRange").addEventListener("pointerdown", () => beginGesture(selected()));
  $("#scaleRange").addEventListener("keydown", () => beginGesture(selected()));
  $("#scaleRange").addEventListener("input", () => {
    const sc = selected(); if (!sc) return;
    beginGesture(sc);
    sc.scale = scaleFromT(+$("#scaleRange").value);
    $("#scaleVal").textContent = "×" + sc.scale.toFixed(2);
    applyParams(sc);
  });
  for (const axis of ["rx", "ry", "rz"]){
    $("#" + axis + "Plus").addEventListener("click", () => {
      const sc = selected(); if (!sc) return;
      pushHistory(sc);
      sc[axis] = wrap180(sc[axis] + 90);
      $("#" + axis + "Range").value = sc[axis];
      $("#" + axis + "Val").textContent = sc[axis] + "°";
      applyParams(sc);
    });
  }
  $("#nameInput").addEventListener("change", () => {
    const sc = selected(); if (!sc) return;
    sc.name = $("#nameInput").value.trim() || sc.name;
    $("#calibTitle").textContent = sc.name;
    markDirty(); renderSceneList();
  });
  $("#visChk").addEventListener("change", () => {
    const sc = selected(); if (!sc) return;
    sc.visible = $("#visChk").checked;
    layer.setVisible(sc.id, sc.visible);
    if (sc.visible && !rt(sc.id).loaded) loadScene(sc).catch(toastError);
    markDirty(); updateStats(); renderSceneList();
  });
  $("#cropChk").addEventListener("change", () => {
    const sc = selected(); if (!sc) return;
    pushHistory(sc);
    sc.crop.on = $("#cropChk").checked;
    $("#cropBody").hidden = !sc.crop.on;
    layer.setCrop(sc.id, sc.crop);
    markDirty(); updateEllipse(sc);
  });
  for (const btn of document.querySelectorAll(".shape-btn")){
    btn.addEventListener("click", () => {
      const sc = selected(); if (!sc) return;
      pushHistory(sc);
      sc.crop.shape = btn.dataset.shape;
      refreshShapeButtons(sc);
      layer.setCrop(sc.id, sc.crop);
      markDirty(); updateEllipse(sc);
    });
  }
  for (const c of cropRanges){
    $(c.r).addEventListener("pointerdown", () => beginGesture(selected()));
    $(c.r).addEventListener("keydown", () => beginGesture(selected()));
    $(c.r).addEventListener("input", () => {
      const sc = selected(); if (!sc) return;
      beginGesture(sc);
      sc.crop[c.k] = +$(c.r).value;
      if (c.k === "hmin" && sc.crop.hmin > sc.crop.hmax){ sc.crop.hmax = sc.crop.hmin; refreshCalib(sc); }
      if (c.k === "hmax" && sc.crop.hmax < sc.crop.hmin){ sc.crop.hmin = sc.crop.hmax; refreshCalib(sc); }
      $(c.l).textContent = c.fmt(sc.crop[c.k]);
      layer.setCrop(sc.id, sc.crop);
      markDirty(); updateEllipse(sc);
    });
  }
  // завершення жесту слайдера — глобально (миша/палець можуть відпуститись будь-де)
  window.addEventListener("pointerup", endGesture);
  window.addEventListener("keyup", endGesture);

  $("#eraseBtn").addEventListener("click", () => {
    const sc = selected(); if (sc) toggleErase(sc);
  });
  $("#eraseThrough").addEventListener("change", () => {
    $("#eraseThroughLabel").textContent = $("#eraseThrough").checked ? "наскрізь (обидва боки)" : "лише поверхня (один бік)";
  });
  $("#undoBtn").addEventListener("click", undo);
  $("#redoBtn").addEventListener("click", redoStep);
  $("#bakeBtn").addEventListener("click", () => {
    const sc = selected();
    if (sc) bakeScene(sc).catch((e) => { toastError(e); hideProgress(); });
  });
  $("#autoLevelBtn").addEventListener("click", () => {
    const sc = selected();
    if (sc) autoLevelScene(sc).catch((e) => { toastError(e); hideProgress(); });
  });
  $("#deleteBtn").addEventListener("click", () => {
    const sc = selected();
    if (sc) deleteScene(sc).catch((e) => { toastError(e); hideProgress(); });
  });
  $("#closeCalib").addEventListener("click", deselect);
  wireEraser();
  wireAlign();
  wireGroups();
}

// акордеон груп: тап по заголовку розкриває одну групу, ховаючи інші
function wireGroups(){
  for (const head of document.querySelectorAll(".acc-head")){
    head.addEventListener("click", () => {
      const grp = head.parentElement;
      const wasOpen = grp.classList.contains("open");
      for (const g of document.querySelectorAll(".acc-group")) g.classList.remove("open");
      if (!wasOpen){
        grp.classList.add("open");
        $("#sheet").classList.add("open");
        setTimeout(() => grp.scrollIntoView({ behavior: "smooth", block: "nearest" }), 100);
      }
    });
  }
}

function refreshShapeButtons(sc){
  for (const btn of document.querySelectorAll(".shape-btn"))
    btn.classList.toggle("active", btn.dataset.shape === sc.crop.shape);
  $("#cropRxLabel").textContent = sc.crop.shape === "rect" ? "Півширина (схід–захід)" : "Радіус схід–захід";
  $("#cropRyLabel").textContent = sc.crop.shape === "rect" ? "Півдовжина (північ–південь)" : "Радіус північ–південь";
}

// ── контур еліпса обрізки на карті + перетягувані ручки ──

function metersToLngLat(sc, e, n){
  const D = Math.PI / 180;
  return [sc.lng + e / (111320 * Math.cos(sc.lat * D)), sc.lat + n / 110540];
}

function lngLatToMeters(sc, ll){
  const D = Math.PI / 180;
  return {
    e: (ll.lng - sc.lng) * 111320 * Math.cos(sc.lat * D),
    n: (ll.lat - sc.lat) * 110540,
  };
}

// точка в crop-локальних координатах (bx схід, by північ) з поворотом rot → lng/lat
function cropLocalToLngLat(sc, bx, by){
  const a = (sc.crop.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return metersToLngLat(sc, c*bx - s*by, s*bx + c*by);
}
// зворотне: точка на карті → crop-локальні координати (з урахуванням rot)
function lngLatToCropLocal(sc, ll){
  const m = lngLatToMeters(sc, ll);
  const a = -(sc.crop.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: c*m.e - s*m.n, y: s*m.e + c*m.n };
}

// Контур обрізки (полігон) + внутрішня сітка, з урахуванням повороту rot.
function cropGeoJSON(sc){
  const rx = sc.crop.rx, ry = sc.crop.ry;
  const outline = [];
  if (sc.crop.shape === "rect"){
    outline.push(cropLocalToLngLat(sc, -rx, -ry), cropLocalToLngLat(sc, rx, -ry),
      cropLocalToLngLat(sc, rx, ry), cropLocalToLngLat(sc, -rx, ry), cropLocalToLngLat(sc, -rx, -ry));
  } else {
    for (let i = 0; i <= 64; i++){
      const a = (i / 64) * 2 * Math.PI;
      outline.push(cropLocalToLngLat(sc, rx * Math.cos(a), ry * Math.sin(a)));
    }
  }
  const features = [
    { type: "Feature", geometry: { type: "Polygon", coordinates: [outline] }, properties: { role: "fill" } },
  ];
  const grid = [];
  const nx = 4, ny = 4;
  const inShape = (e, n) => sc.crop.shape === "rect"
    ? (Math.abs(e) <= rx + 1e-6 && Math.abs(n) <= ry + 1e-6)
    : ((e/rx)*(e/rx) + (n/ry)*(n/ry) <= 1.0001);
  for (let i = 1; i < nx; i++){
    const e = -rx + (2 * rx) * i / nx;
    const seg = [];
    for (let j = 0; j <= 40; j++){
      const n = -ry + (2 * ry) * j / 40;
      if (inShape(e, n)) seg.push(cropLocalToLngLat(sc, e, n));
      else if (seg.length){ grid.push(seg.slice()); seg.length = 0; }
    }
    if (seg.length > 1) grid.push(seg);
  }
  for (let i = 1; i < ny; i++){
    const n = -ry + (2 * ry) * i / ny;
    const seg = [];
    for (let j = 0; j <= 40; j++){
      const e = -rx + (2 * rx) * j / 40;
      if (inShape(e, n)) seg.push(cropLocalToLngLat(sc, e, n));
      else if (seg.length){ grid.push(seg.slice()); seg.length = 0; }
    }
    if (seg.length > 1) grid.push(seg);
  }
  if (grid.length)
    features.push({ type: "Feature", geometry: { type: "MultiLineString", coordinates: grid }, properties: { role: "grid" } });
  return { type: "FeatureCollection", features };
}

const clampR = (v) => Math.max(5, Math.min(500, Math.round(v)));
let handleE = null, handleN = null, handleRot = null; // ручки на карті

function makeHandle(label, cls){
  const el = document.createElement("div");
  el.className = "crop-handle" + (cls ? " " + cls : "");
  el.textContent = label;
  return new maplibregl.Marker({ element: el, draggable: true });
}

function syncHandles(sc){
  const show = sc && sc.crop.on && state.editing;
  if (!show){
    for (const h of [handleE, handleN, handleRot]) if (h) h.remove();
    handleE = handleN = handleRot = null;
    return;
  }
  if (!handleE){
    handleE = makeHandle("↔").addTo(map);
    handleE.on("dragstart", () => beginGesture(selected()));
    handleE.on("drag", () => {
      const s = selected(); if (!s) return;
      s.crop.rx = clampR(Math.abs(lngLatToCropLocal(s, handleE.getLngLat()).x));
      cropChangedLive(s);
    });
    handleE.on("dragend", () => { endGesture(); const s = selected(); if (s) syncHandlePositions(s); });
  }
  if (!handleN){
    handleN = makeHandle("↕").addTo(map);
    handleN.on("dragstart", () => beginGesture(selected()));
    handleN.on("drag", () => {
      const s = selected(); if (!s) return;
      s.crop.ry = clampR(Math.abs(lngLatToCropLocal(s, handleN.getLngLat()).y));
      cropChangedLive(s);
    });
    handleN.on("dragend", () => { endGesture(); const s = selected(); if (s) syncHandlePositions(s); });
  }
  if (!handleRot){
    handleRot = makeHandle("⟳", "rot").addTo(map);
    handleRot.on("dragstart", () => beginGesture(selected()));
    handleRot.on("drag", () => {
      const s = selected(); if (!s) return;
      const m = lngLatToMeters(s, handleRot.getLngLat());
      // напрям на ручку задає локальну вісь «північ» обрізки: rot = atan2(-e, n)
      s.crop.rot = Math.round(Math.atan2(-m.e, m.n) * 180 / Math.PI);
      layer.setCrop(s.id, s.crop);
      const src = map.getSource("crop-ellipse"); if (src) src.setData(cropGeoJSON(s));
      $("#cropRot").value = s.crop.rot; $("#cropRotVal").textContent = s.crop.rot + "°";
      markDirty();
    });
    handleRot.on("dragend", () => { endGesture(); const s = selected(); if (s) syncHandlePositions(s); });
  }
  syncHandlePositions(sc);
}

function syncHandlePositions(sc){
  if (handleE) handleE.setLngLat(cropLocalToLngLat(sc, sc.crop.rx, 0));
  if (handleN) handleN.setLngLat(cropLocalToLngLat(sc, 0, sc.crop.ry));
  if (handleRot) handleRot.setLngLat(cropLocalToLngLat(sc, 0, sc.crop.ry + Math.max(15, sc.crop.ry * 0.25)));
}

// живе оновлення під час перетягування ручки: рендер, контур, слайдери
function cropChangedLive(sc){
  layer.setCrop(sc.id, sc.crop);
  const src = map.getSource("crop-ellipse");
  if (src) src.setData(cropGeoJSON(sc));
  $("#cropRx").value = sc.crop.rx; $("#cropRxVal").textContent = sc.crop.rx + " м";
  $("#cropRy").value = sc.crop.ry; $("#cropRyVal").textContent = sc.crop.ry + " м";
  if (handleRot) handleRot.setLngLat(cropLocalToLngLat(sc, 0, sc.crop.ry + Math.max(15, sc.crop.ry * 0.25)));
  markDirty();
}

function updateEllipse(sc){
  const src = map.getSource("crop-ellipse");
  if (src){
    if (sc && sc.crop.on) src.setData(cropGeoJSON(sc));
    else src.setData({ type: "FeatureCollection", features: [] });
  }
  syncHandles(sc && sc.crop.on ? sc : null);
}

function clearEllipse(){ updateEllipse(null); }

// ── гумка: стирання деталей пальцем/мишкою ──

let eraseActive = false;      // йде мазок зараз
let erasePoints = [];         // точки поточного мазка в CSS-пікселях канви
let eraseFlushTimer = null;

function toggleErase(sc){
  const e = editRec(sc.id);
  e.eraseMode = !e.eraseMode;
  applyEraseMode(sc);
}

function applyEraseMode(sc){
  const e = editRec(sc.id);
  if (e.eraseMode && alignMode) exitAlign(); // гумка й прив'язка взаємовиключні
  const btn = $("#eraseBtn");
  btn.classList.toggle("active", e.eraseMode);
  btn.textContent = e.eraseMode ? "Гумка увімкнена — малюй по сцені (натисни, щоб вимкнути)" : "Гумка — стерти деталі";
  document.body.classList.toggle("erasing", e.eraseMode);
  const canvas = map.getCanvas();
  canvas.style.cursor = e.eraseMode ? "crosshair" : "";
  // під час стирання блокуємо перетягування карти, щоб мазок не рухав вид
  if (e.eraseMode){ map.dragPan.disable(); map.dragRotate.disable(); }
  else if (!alignMode){ map.dragPan.enable(); map.dragRotate.enable(); hideBrushRing(); }
}

function eraseRadiusCss(){
  return +($("#eraseSize") ? $("#eraseSize").value : 24) || 24;
}
function eraseDepthFrac(){
  return ($("#eraseThrough") && $("#eraseThrough").checked) ? 1 : 0.12;
}

// кільце-контур пензля, що йде за курсором
function showBrushRing(x, y){
  let ring = $("#brushRing");
  if (!ring){
    ring = document.createElement("div");
    ring.id = "brushRing";
    document.body.appendChild(ring);
  }
  const r = eraseRadiusCss();
  const rect = map.getCanvas().getBoundingClientRect();
  ring.style.display = "block";
  ring.style.width = ring.style.height = (r * 2) + "px";
  ring.style.left = (rect.left + x) + "px";
  ring.style.top = (rect.top + y) + "px";
}
function hideBrushRing(){ const ring = $("#brushRing"); if (ring) ring.style.display = "none"; }

function wireEraser(){
  const canvas = map.getCanvas();
  const toCss = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };
  canvas.addEventListener("pointerdown", (ev) => {
    const sc = selected(); if (!sc) return;
    if (!editRec(sc.id).eraseMode) return;
    ev.preventDefault();
    pushHistory(sc); // цілий мазок — один крок «назад»
    eraseActive = true;
    const p = toCss(ev);
    erasePoints = [p];
    showBrushRing(p.x, p.y);
    canvas.setPointerCapture(ev.pointerId);
    scheduleEraseFlush(sc);
  });
  canvas.addEventListener("pointermove", (ev) => {
    const sc = selected();
    if (sc && editRec(sc.id).eraseMode){
      const p = toCss(ev);
      showBrushRing(p.x, p.y);
      if (eraseActive){ erasePoints.push(p); scheduleEraseFlush(sc); }
    }
  });
  const finish = () => { eraseActive = false; erasePoints = []; };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  canvas.addEventListener("pointerleave", () => { if (!eraseActive) hideBrushRing(); });
}

// накопичені точки шлемо у рендерер пачками (не частіше ~40 мс)
function scheduleEraseFlush(sc){
  if (!sc || eraseFlushTimer) return;
  eraseFlushTimer = setTimeout(() => {
    eraseFlushTimer = null;
    if (!erasePoints.length) return;
    const batch = erasePoints;
    erasePoints = eraseActive ? [batch[batch.length - 1]] : [];
    layer.eraseStroke(sc.id, batch, eraseRadiusCss(), eraseDepthFrac());
  }, 40);
}

// колбек рендерера після обробки мазка: оновлюємо маску і лічильник
function onEraseResult(id, mask, hit, total){
  const e = editRec(id);
  e.mask = mask;
  const sc = state.scenes.find((s) => s.id === id);
  if (sc){
    updateEraseCount(sc);
    markDirty();
    updateUndoBtn(sc);
  }
}

// ── прив'язка по точках: N відповідностей сплат↔карта → масштаб/поворот/позиція ──

let alignMode = null;      // null | "awaitSrc" | "awaitDst"
let alignPending = null;   // { pos, srcMarker } поки чекаємо точку на карті
const alignMarkers = [];   // усі маркери-пари на карті (для очищення)

function alignRec(sc){
  const e = editRec(sc.id);
  if (!e.align) e.align = []; // [{ src:[x,y,z], dst:[lng,lat] }]
  return e.align;
}

function enterAlign(){
  const sc = selected(); if (!sc) return;
  // вимкнути гумку
  const e = editRec(sc.id);
  if (e.eraseMode){ e.eraseMode = false; applyEraseMode(sc); }
  alignMode = "awaitSrc";
  map.dragPan.disable();
  $("#alignBtn").classList.add("active");
  $("#alignBtn").textContent = "Прив'язка: тапни точку на СПЛАТі";
  updateAlignInfo(sc);
  toast("Тапни характерну точку на сплаті (ріг будинку, перехрестя), потім — те саме місце на супутниковій карті. Треба ≥3 пари.", "info", 9000);
}

function exitAlign(){
  alignMode = null;
  alignPending = null;
  const sc = selected();
  if (sc && !editRec(sc.id).eraseMode) map.dragPan.enable();
  $("#alignBtn").classList.remove("active");
  $("#alignBtn").textContent = "Прив'язка по точках";
}

function clearAlignMarkers(){
  for (const m of alignMarkers) m.remove();
  alignMarkers.length = 0;
  if (alignPending && alignPending.srcMarker) alignPending.srcMarker.remove();
  alignPending = null;
  const src = map.getSource("align-lines");
  if (src) src.setData({ type: "FeatureCollection", features: [] });
}

function alignBadge(num, kind){
  const el = document.createElement("div");
  el.className = "align-badge " + kind;
  el.textContent = num;
  return new maplibregl.Marker({ element: el });
}

function refreshAlignLines(sc){
  const pairs = alignRec(sc);
  const feats = pairs.filter((p) => p.srcLngLat && p.dst).map((p) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: [p.srcLngLat, p.dst] },
    properties: {},
  }));
  const src = map.getSource("align-lines");
  if (src) src.setData({ type: "FeatureCollection", features: feats });
}

function updateAlignInfo(sc){
  const n = alignRec(sc).length;
  $("#alignInfo").textContent = "Пар точок: " + n + (n < 3 ? " (треба ≥3)" : " — можна накладати");
  $("#alignApplyBtn").disabled = n < 2;
}

function onAlignClick(e){
  const sc = selected(); if (!sc || !alignMode) return;
  if (alignMode === "awaitSrc"){
    // вибрати найближчий сплат під точкою натискання
    layer.pickSplat(sc.id, e.point.x, e.point.y, "align");
  } else if (alignMode === "awaitDst" && alignPending){
    const pair = { src: alignPending.pos, srcLngLat: alignPending.srcLngLat, dst: [e.lngLat.lng, e.lngLat.lat] };
    const num = alignRec(sc).length + 1;
    alignRec(sc).push(pair);
    // маркер цілі на карті
    const dm = alignBadge(num, "dst").setLngLat(pair.dst).addTo(map);
    alignMarkers.push(dm, alignPending.srcMarker);
    alignPending = null;
    alignMode = "awaitSrc";
    $("#alignBtn").textContent = "Прив'язка: тапни точку на СПЛАТі";
    refreshAlignLines(sc);
    updateAlignInfo(sc);
  }
}

// колбек вибору сплата
function onPickResult(id, tag, pos){
  const sc = selected();
  if (!sc || sc.id !== id || tag !== "align" || alignMode !== "awaitSrc") return;
  if (!pos){ toast("Тут немає сплата — цілься в саму сцену.", "error"); return; }
  const lngLat = layer.localToLngLat(id, pos);
  const num = alignRec(sc).length + 1;
  const sm = alignBadge(num, "src").setLngLat(lngLat).addTo(map);
  alignPending = { pos, srcLngLat: lngLat, srcMarker: sm };
  alignMode = "awaitDst";
  $("#alignBtn").textContent = "Прив'язка: тапни ЦІЛЬ на карті";
  toast("Тепер тапни на карті, куди має стати ця точка.", "info", 6000);
}

function applyAlign(){
  const sc = selected(); if (!sc) return;
  const pairs = alignRec(sc).filter((p) => p.src && p.dst);
  if (pairs.length < 2){ toast("Постав щонайменше 2 (краще 3+) пари точок.", "error"); return; }
  const D = Math.PI / 180;
  const mPerLng = 111320 * Math.cos(sc.lat * D), mPerLat = 110540;
  // джерело: горизонталь локальної точки після лише вирівнювання (без scale/rz/anchor)
  const srcPts = [], dstPts = [], ups = [];
  for (const p of pairs){
    const h = levelHorizontal(p.src, sc.rx, sc.ry);
    srcPts.push({ x: h.e, y: h.n });
    ups.push(h.u);
    dstPts.push({ x: (p.dst[0] - sc.lng) * mPerLng, y: (p.dst[1] - sc.lat) * mPerLat });
  }
  let sim;
  try { sim = similarity2D(srcPts, dstPts); }
  catch (err){ toast(err.message, "error"); return; }
  if (!(sim.scale > 0) || !Number.isFinite(sim.scale)){ toast("Не вдалося обчислити — розстав точки ширше.", "error"); return; }

  pushHistory(sc);
  sc.scale = Math.max(0.05, Math.min(300, sim.scale));
  sc.rz = wrap180(sim.angleDeg);
  sc.lng = sc.lng + sim.tx / mPerLng;
  sc.lat = sc.lat + sim.ty / mPerLat;
  // висота: посадити вибрані точки на рівень карти
  ups.sort((a, b) => a - b);
  const medUp = ups[ups.length >> 1];
  sc.alt = Math.max(-80, Math.min(200, -sc.scale * medUp));

  layer.setParams(sc.id, sceneParams(sc));
  if (marker) marker.setLngLat([sc.lng, sc.lat]);
  refreshCalib(sc);
  updateEllipse(sc);
  markDirty();
  const rmsMap = sim.rms; // метри
  toast("Накладено по " + pairs.length + " точках. Масштаб ×" + sc.scale.toFixed(2) +
    ", поворот " + sc.rz.toFixed(1) + "°, похибка ≈ " + rmsMap.toFixed(1) + " м. " +
    (rmsMap > 15 ? "Похибка велика — перевір точки або додай ще." : "Готово."), rmsMap > 15 ? "error" : "ok", 11000);
  clearAlignMarkers();
  alignRec(sc).length = 0;
  updateAlignInfo(sc);
  exitAlign();
}

function wireAlign(){
  $("#alignBtn").addEventListener("click", () => {
    if (alignMode) exitAlign(); else enterAlign();
  });
  $("#alignApplyBtn").addEventListener("click", applyAlign);
  $("#alignClearBtn").addEventListener("click", () => {
    const sc = selected(); if (!sc) return;
    clearAlignMarkers();
    alignRec(sc).length = 0;
    updateAlignInfo(sc);
  });
  map.on("click", onAlignClick);
  layer.onPick = onPickResult;
}

// ── експорт усього сайту-карти одним ZIP ──

const SITE_FILES = [
  "index.html", "css/style.css",
  "js/app.js", "js/edit.js", "js/renderer.js", "js/sorter.worker.js",
  "js/gsmath.js", "js/formats.js", "js/github.js", "js/state.js",
  "js/ui.js", "js/zip.js", "test.html", "README.md",
];

async function exportMapZip(){
  try {
    showProgress("Збираю сайт-карту в архів…");
    const files = [];
    // 1) статичні файли сайту (беремо з поточного розгортання Pages)
    for (const path of SITE_FILES){
      try {
        const buf = await fetchWithProgress(path + "?z=" + Date.now());
        files.push({ name: path, data: new Uint8Array(buf) });
      } catch { /* необов'язковий файл (напр. test.html) міг бути відсутній */ }
    }
    // 2) актуальний конфіг сцен
    files.push({ name: "scenes.json", data: new TextEncoder().encode(serializeScenes(state.scenes)) });
    // 3) файли сплатів усіх сцен
    let i = 0;
    for (const sc of state.scenes){
      i++;
      const r = rt(sc.id);
      let bytes;
      if (r.bytesCache){
        bytes = r.bytesCache;
      } else {
        showProgress(`Сцена ${i} з ${state.scenes.length}: ${sc.name} · 0%`, 0);
        try {
          bytes = await fetchWithProgress(sc.file + "?v=" + (sc.v || 0),
            (f) => showProgress(`Сцена ${i} з ${state.scenes.length}: ${sc.name} · ${fmtPct(f)}`, f));
        } catch {
          if (!state.client) throw new Error("Щоб вивантажити сцену «" + sc.name + "», відкрий режим редагування з токеном.");
          bytes = await state.client.getRawFile(sc.file);
        }
      }
      files.push({ name: sc.file, data: new Uint8Array(bytes instanceof Uint8Array ? bytes.buffer : bytes) });
    }
    showProgress("Пакую ZIP…");
    const blob = makeZip(files);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "severo-3d-map-" + new Date().toISOString().slice(0, 10) + ".zip";
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
    toast("Архів карти готовий: " + fmtMB(blob.size) + ". Усередині — повний сайт і всі сплати. Розпакуй і відкрий index.html (карта потребує інтернету для супутникових тайлів).", "ok", 12000);
  } finally {
    hideProgress();
  }
}

// ── додавання сканів ──

async function handleFile(file){
  if (!state.client){ showTokenForm(); toast("Спочатку введи токен GitHub.", "error"); return; }
  try {
    showProgress("Читаю «" + file.name + "»…");
    const buf = await file.arrayBuffer();
    let data;
    if (/\.ply$/i.test(file.name)) data = parsePlyFile(buf);
    else if (/\.splat$/i.test(file.name)) data = parseSplatFile(buf);
    else throw new Error("Підтримуються лише файли .ply та .splat");
    if (!data.count) throw new Error("У файлі немає жодного сплата");
    centerCloud(data); // позиції стають відносними до якоря сцени
    const bytes = writeSplat(data);
    if (bytes.byteLength > HARD_LIMIT)
      throw new Error("Після конвертації файл займає " + fmtMB(bytes.byteLength) +
        " — це більше за ліміт GitHub 95 МБ. Зменш кількість сплатів у SuperSplat і повтори.");
    const id = "s" + Date.now().toString(36);
    const c = map.getCenter();
    const sc = {
      id, name: file.name.replace(/\.(ply|splat)$/i, ""), file: "scenes/" + id + ".splat",
      lng: c.lng, lat: c.lat, alt: 0, rx: 0, ry: 0, rz: 0, scale: 1,
      visible: true, count: data.count, size: bytes.byteLength, v: 0,
      crop: { on: false, shape: "ellipse", rot: 0, rx: 100, ry: 100, hmin: -50, hmax: 200, baked: false },
    };
    state.scenes.push(sc);
    const r = rt(id);
    r.loaded = true; r.needsCommit = true; r.bytesCache = bytes;
    layer.addScene(id, data, sceneParams(sc), true, sc.crop); // рендер одразу, не чекаючи коміту
    markDirty(); renderSceneList(); updateStats(); selectScene(id);
    hideProgress();
    toast("Сцена на карті. Комічу файл у репозиторій…", "info");
    await commitSceneFile(sc);
  } finally {
    hideProgress();
  }
}

async function commitSceneFile(sc){
  const r = rt(sc.id);
  if (!r.needsCommit || !r.bytesCache) return;
  try {
    showProgress("Комічу " + sc.file + " · 0%", 0);
    await state.client.putFile(sc.file, r.bytesCache, "Додано сцену «" + sc.name + "»",
      (f) => showProgress("Комічу " + sc.file + " · " + fmtPct(f), f));
    r.needsCommit = false; // байти лишаємо в кеші для авто-рівня/запікання
    toast("Файл сцени закомічено. Вирівняй її і натисни «Зберегти в архів».", "ok", 8000);
  } catch (err) {
    toastError(err);
    toast("Файл сцени ще не в репозиторії — повторю спробу при «Зберегти в архів».", "error", 9000);
  } finally {
    hideProgress();
  }
}

// Байти сцени: з кешу або з репозиторію через API (працює й до редеплою Pages).
async function sceneBytes(sc, label){
  const r = rt(sc.id);
  if (r.bytesCache) return r.bytesCache;
  showProgress(label + " · 0%", 0);
  const bytes = await state.client.getRawFile(sc.file,
    (f) => showProgress(label + " · " + fmtPct(f), f));
  r.bytesCache = bytes;
  return bytes;
}

// Авто-рівень: кладе сцену «на землю» — вирівнює нахили X/Y по домінантній
// площині і ставить землю на рівень карти. Якщо ввімкнена обрізка, аналізує
// лише сплати всередині неї (сфера «неба» Luma не збиває оцінку).
async function autoLevelScene(sc){
  if (!state.client && !rt(sc.id).bytesCache){ showTokenForm(); return; }
  const bytes = await sceneBytes(sc, "Завантажую сцену для аналізу");
  showProgress("Шукаю площину землі…");
  const data = parseSplatFile(bytes);
  const est = estimateLevel(data.pos, data.count, sc, sc.crop.on ? sc.crop : null);
  hideProgress();
  if (!est){
    toast("Замало сплатів для аналізу (можливо, обрізка відсікає майже все).", "error");
    return;
  }
  sc.rx = Math.round(est.rx * 2) / 2;
  sc.ry = Math.round(est.ry * 2) / 2;
  sc.alt = Math.round(est.alt * 2) / 2;
  refreshCalib(sc);
  applyParams(sc);
  toast("Вирівняно по землі: нахили X/Y і висоту підібрано. Тепер підганяй масштаб і позицію по будинках. Якщо сцена «догори дриґом» — крутни X на +90° двічі й повтори авто-рівень.", "ok", 10000);
}

// ── збереження, експорт ──

async function saveArchive(){
  if (!state.client){ showTokenForm(); return; }
  // Запобіжник від втрати даних: не затирати непорожній архів порожнім списком
  // без явного підтвердження (саме так конфіг колись обнулився).
  if (state.scenes.length === 0){
    let remoteHas = false;
    try {
      const cur = await state.client.getRawFile("scenes.json");
      const j = JSON.parse(new TextDecoder().decode(cur));
      remoteHas = Array.isArray(j.scenes) && j.scenes.length > 0;
    } catch { /* немає файлу або не читається — тоді порожній зберегти можна */ }
    if (remoteHas && !confirm("Список сцен зараз порожній, а в архіві є збережені сцени. Зберегти ПОРОЖНІЙ список? Це прибере всі сцени з карти (файли сплатів у scenes/ лишаться).")){
      hideProgress();
      toast("Скасовано — порожній scenes.json не збережено.", "info");
      return;
    }
  }
  for (const sc of state.scenes)
    if (rt(sc.id).needsCommit) await commitSceneFile(sc);
  const pending = state.scenes.filter((sc) => rt(sc.id).needsCommit);
  if (pending.length){
    toast("Не всі файли сцен вдалося закомітити — scenes.json не оновлюю, щоб не втратити дані.", "error", 9000);
    return;
  }
  showProgress("Зберігаю scenes.json…");
  try {
    await state.client.putFileSmall("scenes.json", serializeScenes(state.scenes),
      "Оновлено конфігурацію сцен");
    state.dirty = false;
    updateDirtyDot();
    toast("Збережено в архів. GitHub Pages оновиться приблизно за 1–2 хвилини.", "ok", 9000);
  } finally {
    hideProgress();
  }
}

// ── запікання: обрізка + стертий гумкою назавжди ──

async function bakeScene(sc){
  if (!state.client){ showTokenForm(); return; }
  const e = editRec(sc.id);
  const hasCrop = sc.crop.on;
  const hasErase = e.mask && e.mask.some((v) => v);
  if (!hasCrop && !hasErase){ toast("Немає що запікати — увімкни обрізку або зітри щось гумкою.", "info"); return; }
  const what = hasCrop && hasErase ? "обрізку і стирання" : hasCrop ? "обрізку" : "стирання";
  if (!confirm("Запекти " + what + " назавжди? Оригінал буде збережено поруч як " +
    sc.file.replace(/\.splat$/, ".orig.splat") + ".")) return;

  const r = rt(sc.id);
  const origBytes = await sceneBytes(sc, "Завантажую оригінал сцени");
  showProgress("Фільтрую сплати…");
  const data = parseSplatFile(origBytes); // без центрування — позиції вже центровані
  const keep = filterCrop(data.pos, data.count, sc, sc.crop, e.mask, hasCrop);
  if (!keep.length) throw new Error("Фільтр відсікає всі сплати — послаб обрізку або скасуй стирання.");
  if (keep.length === data.count){
    hideProgress();
    toast("Нічого не відсікається — запікати нема чого.", "info");
    return;
  }
  const newBytes = writeSplat(data, keep);
  const removed = data.count - keep.length;
  const savedBytes = origBytes.byteLength - newBytes.byteLength;

  // 1) оригінал → *.orig.splat (лише якщо його там ще нема)
  const origPath = sc.file.replace(/\.splat$/, ".orig.splat");
  const origSha = await state.client.getFileSha(origPath);
  if (!origSha){
    showProgress("Зберігаю оригінал " + origPath + " · 0%", 0);
    await state.client.putFile(origPath, origBytes, "Оригінал сцени «" + sc.name + "» перед запіканням",
      (f) => showProgress("Зберігаю оригінал · " + fmtPct(f), f));
  }
  // 2) обрізаний файл замість старого
  showProgress("Комічу оброблену сцену · 0%", 0);
  await state.client.putFile(sc.file, newBytes, "Запечено " + what + " сцени «" + sc.name + "»",
    (f) => showProgress("Комічу оброблену сцену · " + fmtPct(f), f));

  // 3) оновлюємо сцену і рендер (маска і історія скидаються — вони вже у файлі)
  sc.count = keep.length;
  sc.size = newBytes.byteLength;
  sc.v = (sc.v || 0) + 1;
  sc.crop.on = false;
  sc.crop.baked = true;
  // маска, історія й точки прив'язки скидаються — вони вже враховані у файлі
  e.mask = null; e.history = []; e.redo = []; e.align = [];
  e.eraseMode = false;
  clearAlignMarkers();
  r.bytesCache = newBytes; r.needsCommit = false;
  const newData = parseSplatFile(newBytes);
  layer.addScene(sc.id, newData, sceneParams(sc), sc.visible, sc.crop);
  refreshCalib(sc);
  applyEraseMode(sc);
  clearEllipse();
  updateEraseCount(sc);
  updateAlignInfo(sc);
  updateUndoBtn(sc);
  renderSceneList(); updateStats();

  // 4) фіксуємо конфігурацію
  await saveArchive();
  toast("Запечено: −" + fmtInt(removed) + " сплатів · −" + fmtMB(savedBytes) +
    " (лишилось " + fmtInt(keep.length) + ")", "ok", 10000);
}

// ── видалення ──

async function deleteScene(sc){
  if (!state.client){ showTokenForm(); return; }
  if (!confirm("Видалити сцену «" + sc.name + "» разом із файлом " + sc.file + "?")) return;
  if (!confirm("Точно видалити? Дію не можна скасувати. Файл зникне з репозиторію.")) return;
  layer.removeScene(sc.id);
  state.scenes = state.scenes.filter((s) => s !== sc);
  state.runtime.delete(sc.id);
  deselect();
  renderSceneList(); updateStats();
  showProgress("Видаляю файли сцени…");
  try {
    await state.client.deleteFile(sc.file, "Видалено сцену «" + sc.name + "»");
    await state.client.deleteFile(sc.file.replace(/\.splat$/, ".orig.splat"),
      "Видалено оригінал сцени «" + sc.name + "»");
    await state.client.putFileSmall("scenes.json", serializeScenes(state.scenes),
      "Видалено сцену «" + sc.name + "» зі scenes.json");
    state.dirty = false;
    updateDirtyDot();
    toast("Сцену видалено з архіву.", "ok");
  } finally {
    hideProgress();
  }
}

// ── разове підключення обробників ──

let wired = false;
function wireOnce(){
  if (wired) return;
  wired = true;
  wireCalib();

  $("#tokenForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = $("#tokenInput").value.trim();
    if (!token) return;
    if (!/^[\x21-\x7e]+$/.test(token)){
      toast("У токені є недопустимий символ (можливо, скопіювався не весь, з пробілом чи «…» усередині). Скопіюй токен із GitHub ще раз повністю.", "error", 9000);
      return;
    }
    initClient(token);
    try {
      showProgress("Перевіряю токен…");
      const repoName = await state.client.checkAccess();
      localStorage.setItem(LS_TOKEN, token);
      $("#tokenInput").value = "";
      showTools();
      toast("Токен прийнято (" + repoName + "). Можна додавати скани.", "ok");
    } catch (err) {
      state.client = null;
      if (err && err.status === 0){
        showProgress("З'ясовую причину…");
        const alive = await probeGitHub();
        toast(alive
          ? "GitHub доступний, але запит із токеном не пройшов. Найчастіше це блокувальник контенту в Safari (Налаштування → Safari → Розширення) або VPN — вимкни їх для цього сайту і спробуй ще раз."
          : "GitHub недоступний із цієї мережі. Перемкни Wi-Fi ↔ мобільний інтернет, вимкни VPN чи приватний ретранслятор і спробуй ще раз.",
          "error", 12000);
      } else {
        toastError(err);
      }
    } finally {
      hideProgress();
    }
  });

  $("#addBtn").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", () => {
    const f = $("#fileInput").files[0];
    $("#fileInput").value = "";
    if (f) handleFile(f).catch((e) => { toastError(e); hideProgress(); });
  });

  const mapEl = map.getContainer();
  mapEl.addEventListener("dragover", (e) => { e.preventDefault(); });
  mapEl.addEventListener("drop", (e) => {
    e.preventDefault();
    if (!state.editing) return;
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f).catch((err) => { toastError(err); hideProgress(); });
  });

  $("#saveBtn").addEventListener("click", () =>
    saveArchive().catch((e) => { toastError(e); hideProgress(); }));
  $("#exportBtn").addEventListener("click", () =>
    downloadText("scenes.json", serializeScenes(state.scenes)));
  $("#exportMapBtn").addEventListener("click", () =>
    exportMapZip().catch((e) => { toastError(e); hideProgress(); }));
  $("#forgetBtn").addEventListener("click", () => {
    localStorage.removeItem(LS_TOKEN);
    state.client = null;
    showTokenForm();
    toast("Токен видалено з цього пристрою.", "info");
  });
}
wireOnce();
