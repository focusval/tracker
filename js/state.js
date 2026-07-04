// Спільний стан застосунку + нормалізація scenes.json (джерела правди).

export const START = { center: [38.4933, 48.948], zoom: 13.5, pitch: 50 };

export const state = {
  scenes: [],          // конфіги сцен зі scenes.json (у пам'яті)
  runtime: new Map(),  // id -> { loaded, loading, pendingBytes, committed }
  dirty: false,        // є незбережені зміни конфігурації
  editing: false,
  selectedId: null,
  client: null,        // GitHubClient у режимі редагування
};

export function rt(id){
  let r = state.runtime.get(id);
  if (!r){ r = { loaded: false, loading: false, pendingBytes: null, committed: true }; state.runtime.set(id, r); }
  return r;
}

const num = (v, d) => (Number.isFinite(+v) ? +v : d);

// scenes.json може бути {} (порожній архів) — це нормальний стан.
export function normalizeScenes(json){
  const list = Array.isArray(json && json.scenes) ? json.scenes : [];
  return list.map((s, i) => ({
    id: String(s.id != null ? s.id : "scene-" + i),
    name: String(s.name != null ? s.name : (s.file || "Сцена " + (i + 1))),
    file: String(s.file || ""),
    lng: num(s.lng, START.center[0]), lat: num(s.lat, START.center[1]), alt: num(s.alt, 0),
    rx: num(s.rx, 0), ry: num(s.ry, 0), rz: num(s.rz, 0),
    scale: num(s.scale, 1),
    visible: s.visible !== false,
    count: num(s.count, 0),
    size: num(s.size, 0),
    v: num(s.v, 0),
    crop: {
      on: !!(s.crop && s.crop.on),
      rx: num(s.crop && s.crop.rx, 100),
      ry: num(s.crop && s.crop.ry, 100),
      hmin: num(s.crop && s.crop.hmin, -50),
      hmax: num(s.crop && s.crop.hmax, 200),
      baked: !!(s.crop && s.crop.baked),
    },
  })).filter((s) => s.file);
}

export function serializeScenes(scenes){
  return JSON.stringify({
    version: 1,
    updated: new Date().toISOString(),
    scenes: scenes.map((s) => ({
      id: s.id, name: s.name, file: s.file,
      lng: s.lng, lat: s.lat, alt: s.alt,
      rx: s.rx, ry: s.ry, rz: s.rz,
      scale: s.scale, visible: s.visible,
      count: s.count, size: s.size, v: s.v,
      crop: { on: s.crop.on, rx: s.crop.rx, ry: s.crop.ry,
              hmin: s.crop.hmin, hmax: s.crop.hmax, baked: s.crop.baked },
    })),
  }, null, 2);
}

// Параметри сцени у форматі, який очікує рендерер.
export function sceneParams(s){
  return { lng: s.lng, lat: s.lat, alt: s.alt, rx: s.rx, ry: s.ry, rz: s.rz, scale: s.scale };
}

// Визначення репозиторію з адреси GitHub Pages (owner.github.io/repo/).
export function detectRepo(){
  const host = location.hostname;
  if (host.endsWith(".github.io")){
    const owner = host.split(".")[0];
    const seg = location.pathname.split("/").filter(Boolean)
      .filter((p) => !p.endsWith(".html"));
    if (seg.length) return { owner, repo: seg[0] };
    return { owner, repo: host };
  }
  return { owner: "focusval", repo: "tracker" };
}
