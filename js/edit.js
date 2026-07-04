// Режим редагування: токен, додавання сканів, калібрування, обрізка,
// запікання, збереження в репозиторій. Підвантажується динамічно з app.js.

import { map, layer, renderSceneList, updateStats, loadScene } from "./app.js";
import { parsePlyFile, parseSplatFile, writeSplat } from "./formats.js";
import { centerCloud, filterCrop, estimateLevel } from "./gsmath.js";
import { GitHubClient, HARD_LIMIT, probeGitHub } from "./github.js";
import { state, rt, serializeScenes, sceneParams, detectRepo } from "./state.js";
import { $, toast, toastError, showProgress, hideProgress, fmtInt, fmtMB, fmtPct, downloadText } from "./ui.js";

const LS_TOKEN = "severo3d.token";
let marker = null;

// ── вхід/вихід ──

export function toggleEdit(){
  if (state.editing) exitEdit(); else enterEdit();
}

function enterEdit(){
  state.editing = true;
  document.body.classList.add("editing");
  $("#editBtn").textContent = "Готово";
  $("#sheet").classList.add("open");
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
  renderSceneList();
  // розкрити шторку і показати панель — інакше на телефоні її не видно
  $("#sheet").classList.add("open");
  setTimeout(() => $("#calib").scrollIntoView({ behavior: "smooth", block: "start" }), 250);
}

function deselect(){
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

// шкала масштабу — логарифмічна: 0..1000 → 0.05×..20×
const scaleFromT = (t) => 0.05 * Math.pow(400, t / 1000);
const tFromScale = (s) => Math.round(1000 * Math.log(s / 0.05) / Math.log(400));
const wrap180 = (v) => ((v + 180) % 360 + 360) % 360 - 180;

const ranges = [
  { r: "#altRange",  l: "#altVal",  get: (s) => s.alt,   set: (s, v) => { s.alt = v; },   fmt: (v) => v.toFixed(1) + " м" },
  { r: "#rxRange",   l: "#rxVal",   get: (s) => s.rx,    set: (s, v) => { s.rx = v; },    fmt: (v) => v + "°" },
  { r: "#ryRange",   l: "#ryVal",   get: (s) => s.ry,    set: (s, v) => { s.ry = v; },    fmt: (v) => v + "°" },
  { r: "#rzRange",   l: "#rzVal",   get: (s) => s.rz,    set: (s, v) => { s.rz = v; },    fmt: (v) => v + "°" },
];

const cropRanges = [
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
  for (const c of cropRanges){
    $(c.r).value = sc.crop[c.k];
    $(c.l).textContent = c.fmt(sc.crop[c.k]);
  }
}

function wireCalib(){
  for (const c of ranges){
    $(c.r).addEventListener("input", () => {
      const sc = selected(); if (!sc) return;
      c.set(sc, +$(c.r).value);
      $(c.l).textContent = c.fmt(c.get(sc));
      applyParams(sc);
    });
  }
  $("#scaleRange").addEventListener("input", () => {
    const sc = selected(); if (!sc) return;
    sc.scale = scaleFromT(+$("#scaleRange").value);
    $("#scaleVal").textContent = "×" + sc.scale.toFixed(2);
    applyParams(sc);
  });
  for (const axis of ["rx", "ry", "rz"]){
    $("#" + axis + "Plus").addEventListener("click", () => {
      const sc = selected(); if (!sc) return;
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
    sc.crop.on = $("#cropChk").checked;
    $("#cropBody").hidden = !sc.crop.on;
    layer.setCrop(sc.id, sc.crop);
    markDirty(); updateEllipse(sc);
  });
  for (const c of cropRanges){
    $(c.r).addEventListener("input", () => {
      const sc = selected(); if (!sc) return;
      sc.crop[c.k] = +$(c.r).value;
      if (c.k === "hmin" && sc.crop.hmin > sc.crop.hmax){ sc.crop.hmax = sc.crop.hmin; refreshCalib(sc); }
      if (c.k === "hmax" && sc.crop.hmax < sc.crop.hmin){ sc.crop.hmin = sc.crop.hmax; refreshCalib(sc); }
      $(c.l).textContent = c.fmt(sc.crop[c.k]);
      layer.setCrop(sc.id, sc.crop);
      markDirty(); updateEllipse(sc);
    });
  }
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

function ellipseGeoJSON(sc){
  const pts = [];
  for (let i = 0; i <= 64; i++){
    const a = (i / 64) * 2 * Math.PI;
    pts.push(metersToLngLat(sc, sc.crop.rx * Math.cos(a), sc.crop.ry * Math.sin(a)));
  }
  return { type: "FeatureCollection", features: [
    { type: "Feature", geometry: { type: "Polygon", coordinates: [pts] }, properties: {} },
  ] };
}

const clampR = (v) => Math.max(5, Math.min(500, Math.round(v)));
let handleE = null, handleN = null; // ручки зміни радіусів прямо на карті

function makeHandle(label){
  const el = document.createElement("div");
  el.className = "crop-handle";
  el.textContent = label;
  return new maplibregl.Marker({ element: el, draggable: true });
}

function syncHandles(sc){
  const show = sc && sc.crop.on && state.editing;
  if (!show){
    if (handleE){ handleE.remove(); handleE = null; }
    if (handleN){ handleN.remove(); handleN = null; }
    return;
  }
  if (!handleE){
    handleE = makeHandle("↔").setLngLat(metersToLngLat(sc, sc.crop.rx, 0)).addTo(map);
    handleE.on("drag", () => {
      const s = selected(); if (!s) return;
      s.crop.rx = clampR(Math.abs(lngLatToMeters(s, handleE.getLngLat()).e));
      cropChangedLive(s);
    });
    handleE.on("dragend", () => { const s = selected(); if (s) syncHandlePositions(s); });
  }
  if (!handleN){
    handleN = makeHandle("↕").setLngLat(metersToLngLat(sc, 0, sc.crop.ry)).addTo(map);
    handleN.on("drag", () => {
      const s = selected(); if (!s) return;
      s.crop.ry = clampR(Math.abs(lngLatToMeters(s, handleN.getLngLat()).n));
      cropChangedLive(s);
    });
    handleN.on("dragend", () => { const s = selected(); if (s) syncHandlePositions(s); });
  }
  syncHandlePositions(sc);
}

function syncHandlePositions(sc){
  if (handleE) handleE.setLngLat(metersToLngLat(sc, sc.crop.rx, 0));
  if (handleN) handleN.setLngLat(metersToLngLat(sc, 0, sc.crop.ry));
}

// живе оновлення під час перетягування ручки: рендер, контур, слайдери
function cropChangedLive(sc){
  layer.setCrop(sc.id, sc.crop);
  const src = map.getSource("crop-ellipse");
  if (src) src.setData(ellipseGeoJSON(sc));
  $("#cropRx").value = sc.crop.rx; $("#cropRxVal").textContent = sc.crop.rx + " м";
  $("#cropRy").value = sc.crop.ry; $("#cropRyVal").textContent = sc.crop.ry + " м";
  markDirty();
}

function updateEllipse(sc){
  const src = map.getSource("crop-ellipse");
  if (src){
    if (sc && sc.crop.on) src.setData(ellipseGeoJSON(sc));
    else src.setData({ type: "FeatureCollection", features: [] });
  }
  syncHandles(sc && sc.crop.on ? sc : null);
}

function clearEllipse(){ updateEllipse(null); }

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
      crop: { on: false, rx: 100, ry: 100, hmin: -50, hmax: 200, baked: false },
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

// ── запікання обрізки ──

async function bakeScene(sc){
  if (!state.client){ showTokenForm(); return; }
  if (!sc.crop.on){ toast("Спочатку увімкни і налаштуй обрізку.", "info"); return; }
  if (!confirm("Запекти обрізку назавжди? Оригінал буде збережено поруч як " +
    sc.file.replace(/\.splat$/, ".orig.splat") + ".")) return;

  const r = rt(sc.id);
  const origBytes = await sceneBytes(sc, "Завантажую оригінал сцени");
  showProgress("Фільтрую сплати…");
  const data = parseSplatFile(origBytes); // без центрування — позиції вже центровані
  const keep = filterCrop(data.pos, data.count, sc, sc.crop);
  if (!keep.length) throw new Error("Обрізка відсікає всі сплати — розшир еліпс або діапазон висот.");
  if (keep.length === data.count){
    hideProgress();
    toast("Обрізка нічого не відсікає — запікати нема чого.", "info");
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
  showProgress("Комічу обрізану сцену · 0%", 0);
  await state.client.putFile(sc.file, newBytes, "Запечено обрізку сцени «" + sc.name + "»",
    (f) => showProgress("Комічу обрізану сцену · " + fmtPct(f), f));

  // 3) оновлюємо сцену і рендер
  sc.count = keep.length;
  sc.size = newBytes.byteLength;
  sc.v = (sc.v || 0) + 1;
  sc.crop.on = false;
  sc.crop.baked = true;
  r.bytesCache = newBytes; r.needsCommit = false;
  const newData = parseSplatFile(newBytes);
  layer.addScene(sc.id, newData, sceneParams(sc), sc.visible, sc.crop);
  refreshCalib(sc);
  clearEllipse();
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
  $("#forgetBtn").addEventListener("click", () => {
    localStorage.removeItem(LS_TOKEN);
    state.client = null;
    showTokenForm();
    toast("Токен видалено з цього пристрою.", "info");
  });
}
wireOnce();
