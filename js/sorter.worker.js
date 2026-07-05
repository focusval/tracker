// Воркер сортування сплатів back-to-front: глибина = -(рядок w MVP · позиція),
// лічильне сортування на 65536 кошиків. Позиції кожної сцени передаються
// один раз повідомленням {type:"add"}. Додатково тримає маску «стертих»
// сплатів (гумка): стерті не потрапляють в індекс і не малюються.
const scenes = {};
const masks = {};
// перевикористовувані буфери проєкції (щоб не алокувати на кожен мазок)
let scratchN = 0, sxA = null, syA = null, cwA = null;
function ensureScratch(n){
  if (n > scratchN){ scratchN = n; sxA = new Float32Array(n); syA = new Float32Array(n); cwA = new Float32Array(n); }
  return scratchN;
}
onmessage = (e) => {
  const d = e.data;
  if (d.type === "add") { scenes[d.id] = new Float32Array(d.positions); delete masks[d.id]; return; }
  if (d.type === "remove") { delete scenes[d.id]; delete masks[d.id]; return; }

  if (d.type === "setMask") { // відновлення маски (крок назад)
    if (d.mask) masks[d.id] = new Uint8Array(d.mask);
    else delete masks[d.id];
    return;
  }

  if (d.type === "erase") {
    // Стирання пензлем із урахуванням глибини: щоб стерти лише один бік
    // об'єкта (напр. фасад будинку), для кожної точки мазка спершу знаходимо
    // найближчий сплат, і стираємо тільки ті, що в межах depthFrac від нього.
    const f = scenes[d.id]; if (!f) return;
    const n = f.length / 3;
    let mask = masks[d.id];
    if (!mask) mask = masks[d.id] = new Uint8Array(n);
    const m = d.mvp, pts = d.points, r2 = d.r * d.r;
    const W = d.w, H = d.h;
    const depthFrac = d.depthFrac == null ? 0.15 : d.depthFrac; // 1 = наскрізь
    const through = depthFrac >= 0.999;

    // екранні координати + cw одним проходом (кеш для двох фаз)
    ensureScratch(n);
    for (let i = 0; i < n; i++) {
      const x = f[3*i], y = f[3*i+1], z = f[3*i+2];
      const cw = m[3]*x + m[7]*y + m[11]*z + m[15];
      cwA[i] = cw;
      if (cw > 0) {
        sxA[i] = ((m[0]*x + m[4]*y + m[8]*z + m[12]) / cw * 0.5 + 0.5) * W;
        syA[i] = (0.5 - (m[1]*x + m[5]*y + m[9]*z + m[13]) / cw * 0.5) * H;
      }
    }
    // фаза 1: найближча глибина (cw) під кожною точкою мазка
    const nearCw = through ? null : new Float32Array(pts.length).fill(Infinity);
    if (!through) {
      for (let i = 0; i < n; i++) {
        if (mask[i] || cwA[i] <= 0) continue;
        for (let k = 0; k < pts.length; k++) {
          const dx = sxA[i] - pts[k].x, dy = syA[i] - pts[k].y;
          if (dx*dx + dy*dy <= r2 && cwA[i] < nearCw[k]) nearCw[k] = cwA[i];
        }
      }
    }
    // фаза 2: стираємо у радіусі й у межах глибини
    let hit = 0;
    for (let i = 0; i < n; i++) {
      if (mask[i] || cwA[i] <= 0) continue;
      for (let k = 0; k < pts.length; k++) {
        const dx = sxA[i] - pts[k].x, dy = syA[i] - pts[k].y;
        if (dx*dx + dy*dy > r2) continue;
        if (through || cwA[i] <= nearCw[k] * (1 + depthFrac)) { mask[i] = 1; hit++; break; }
      }
    }
    let total = 0;
    for (let i = 0; i < n; i++) total += mask[i];
    const copy = mask.slice();
    postMessage({ id: d.id, erased: true, hit, total, mask: copy.buffer }, [copy.buffer]);
    return;
  }

  if (d.type === "pick") {
    // Вибір найближчого до екранної точки фронтального сплата (для прив'язки
    // по точках): повертає локальну позицію сплата.
    const f = scenes[d.id]; if (!f) { postMessage({ id: d.id, picked: true, found: false, tag: d.tag }); return; }
    const n = f.length / 3;
    const m = d.mvp, px = d.x, py = d.y, W = d.w, H = d.h, r2 = d.r * d.r;
    let bestI = -1, bestCw = Infinity, bestD2 = r2;
    // спершу шукаємо фронтальний сплат у малому радіусі; серед близьких —
    // найменший cw (найближчий до камери)
    for (let i = 0; i < n; i++) {
      const x = f[3*i], y = f[3*i+1], z = f[3*i+2];
      const cw = m[3]*x + m[7]*y + m[11]*z + m[15];
      if (cw <= 0) continue;
      const sx = ((m[0]*x + m[4]*y + m[8]*z + m[12]) / cw * 0.5 + 0.5) * W;
      const sy = (0.5 - (m[1]*x + m[5]*y + m[9]*z + m[13]) / cw * 0.5) * H;
      const dx = sx - px, dy = sy - py, dd = dx*dx + dy*dy;
      if (dd <= r2 && cw < bestCw){ bestCw = cw; bestI = i; }
      else if (bestI < 0 && dd < bestD2){ bestD2 = dd; bestI = i; }
    }
    if (bestI < 0) { postMessage({ id: d.id, picked: true, found: false, tag: d.tag }); return; }
    postMessage({ id: d.id, picked: true, found: true, tag: d.tag,
      pos: [f[3*bestI], f[3*bestI+1], f[3*bestI+2]] });
    return;
  }

  if (d.type !== "sort") return;
  const f = scenes[d.id]; if (!f) return;
  const n = f.length / 3;
  const mask = masks[d.id] || null;
  const r0 = d.row[0], r1 = d.row[1], r2 = d.row[2];
  let min = Infinity, max = -Infinity;
  const size = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (mask && mask[i]) continue;
    const depth = (-(r0*f[3*i] + r1*f[3*i+1] + r2*f[3*i+2]) * 4096) | 0;
    size[i] = depth;
    if (depth > max) max = depth; if (depth < min) min = depth;
  }
  const inv = 65535 / ((max - min) || 1);
  const counts = new Uint32Array(65536);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    if (mask && mask[i]) continue;
    size[i] = ((size[i]-min)*inv)|0; counts[size[i]]++; kept++;
  }
  const starts = new Uint32Array(65536);
  for (let i = 1; i < 65536; i++) starts[i] = starts[i-1] + counts[i-1];
  const index = new Uint32Array(kept);
  for (let i = 0; i < n; i++) {
    if (mask && mask[i]) continue;
    index[starts[size[i]]++] = i;
  }
  postMessage({ id: d.id, index }, [index.buffer]);
};
