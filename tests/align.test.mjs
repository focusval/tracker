// Тести підгонки по точках і рівня землі: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { similarity2D, levelHorizontal, groundLevel, cropKeeps, rotationFromEuler } from "../js/gsmath.js";

const R2 = (deg) => { const a = deg*Math.PI/180, c=Math.cos(a), s=Math.sin(a); return (p) => ({ x: c*p.x - s*p.y, y: s*p.x + c*p.y }); };

test("similarity2D: відновлює масштаб, поворот і зсув точно", () => {
  const src = [{x:0,y:0},{x:10,y:0},{x:10,y:5},{x:0,y:5},{x:3,y:2}];
  const s = 2.5, phi = 37, tx = 100, ty = -40;
  const rot = R2(phi);
  const dst = src.map((p) => { const r = rot(p); return { x: s*r.x + tx, y: s*r.y + ty }; });
  const est = similarity2D(src, dst);
  assert.ok(Math.abs(est.scale - s) < 1e-9, `scale ${est.scale}`);
  assert.ok(Math.abs(est.angleDeg - phi) < 1e-7, `angle ${est.angleDeg}`);
  assert.ok(Math.abs(est.tx - tx) < 1e-6 && Math.abs(est.ty - ty) < 1e-6);
  assert.ok(est.rms < 1e-6, `rms ${est.rms}`);
});

test("similarity2D: стійка до шуму (rms > 0, параметри близькі)", () => {
  const src = [];
  for (let i = 0; i < 12; i++) src.push({ x: Math.cos(i)*20, y: Math.sin(i*1.3)*20 });
  const s = 1.7, phi = -22, tx = 5, ty = 8;
  const rot = R2(phi);
  const dst = src.map((p, i) => {
    const r = rot(p);
    const jitter = ((i * 2654435761) % 1000 / 1000 - 0.5) * 0.4; // детермінований ±0.2
    return { x: s*r.x + tx + jitter, y: s*r.y + ty - jitter };
  });
  const est = similarity2D(src, dst);
  assert.ok(Math.abs(est.scale - s) < 0.05, `scale ${est.scale}`);
  assert.ok(Math.abs(est.angleDeg - phi) < 2, `angle ${est.angleDeg}`);
  assert.ok(est.rms < 0.5);
});

test("similarity2D: дві точки задають перетворення однозначно", () => {
  const src = [{x:0,y:0},{x:10,y:0}];
  const dst = [{x:5,y:5},{x:5,y:25}]; // масштаб 2, поворот +90°, зсув (5,5)
  const est = similarity2D(src, dst);
  assert.ok(Math.abs(est.scale - 2) < 1e-9);
  assert.ok(Math.abs(est.angleDeg - 90) < 1e-7);
  assert.ok(Math.abs(est.tx - 5) < 1e-9 && Math.abs(est.ty - 5) < 1e-9);
});

test("similarity2D: помилки на виродженому вводі", () => {
  assert.throws(() => similarity2D([{x:0,y:0}], [{x:1,y:1}]), /щонайменше 2/);
  assert.throws(() => similarity2D([{x:3,y:3},{x:3,y:3}], [{x:0,y:0},{x:1,y:1}]), /збігаються/);
});

test("levelHorizontal: без нахилу повертає x,y локальні", () => {
  const h = levelHorizontal([4, -7, 9], 0, 0);
  assert.ok(Math.abs(h.e - 4) < 1e-12 && Math.abs(h.n + 7) < 1e-12 && Math.abs(h.u - 9) < 1e-12);
});

test("levelHorizontal: rx=90 переводить вертикаль у північ", () => {
  // Rx(90): (0,0,1) → третій стовпець R = (r02,r12,r22)
  const h = levelHorizontal([0, 0, 1], 90, 0);
  // z-вісь після Ry·Rx(90): e≈0, n≈-1 або +1, u≈0
  assert.ok(Math.abs(h.u) < 1e-9, `u=${h.u}`);
  assert.ok(Math.abs(Math.abs(h.n) - 1) < 1e-9, `n=${h.n}`);
});

test("cropKeeps: поворот обрізки rot=45° пропускає діагональ, відсікає вісь", () => {
  const crop = { shape: "rect", rot: 45, rx: 10, ry: 2, hmin: -50, hmax: 50 };
  // вузький прямокутник (10×2), повернутий на 45°: точка вздовж діагоналі (7,7)
  // потрапляє (обертається назад у ~(9.9, 0)), а (0,7) — ні
  assert.equal(cropKeeps(crop, 7, 7, 0), true);
  assert.equal(cropKeeps(crop, 0, 7, 0), false);
  assert.equal(cropKeeps(crop, -7, -7, 0), true);
});

test("groundLevel: щільний шар землі під викидами", () => {
  const vals = [];
  for (let i = 0; i < 2000; i++) vals.push((Math.sin(i) - 0.99) * 0.05 + 3);  // земля ≈ 3
  for (let i = 0; i < 300; i++) vals.push(3 + Math.abs(Math.sin(i*2)) * 20);  // будівлі вгору
  for (let i = 0; i < 20; i++) vals.push(-10 - i);                            // викиди вниз
  const g = groundLevel(vals);
  assert.ok(Math.abs(g - 3) < 1.5, `ground ${g}, очікував ≈3 (не тягнеться до викидів -10..-30)`);
});

// Round-trip повного накладання (контракт applyAlign): якщо цілі — це справжня
// проєкція сплатів під відомим перетворенням (той самий rx/ry, що в сцені),
// то similarity2D+levelHorizontal мають відновити масштаб, yaw і зсув так, що
// сплати лягають РІВНО на цілі. Відтворює математику edit.js applyAlign без DOM.
test("накладання по точках: сплати лягають рівно на цілі (round-trip)", () => {
  const DEG = 180 / Math.PI;
  // сцена вже вирівняна авто-рівнем: rx/ry фіксовані, align вирішує scale/rz/зсув
  const rx = 7, ry = -4;
  // «істинне» перетворення, яке ми маємо відновити
  const trueScale = 12.5, trueRz = 63; // градуси
  const lng0 = 38.49, lat0 = 48.94;
  const D = Math.PI / 180;
  const mPerLng = 111320 * Math.cos(lat0 * D), mPerLat = 110540;
  // горизонтальна проєкція локальної точки під повним поворотом Rz·Ry·Rx (метри)
  const project = (p) => {
    const h = levelHorizontal(p, rx, ry);       // Ry·Rx
    const a = trueRz * D, c = Math.cos(a), s = Math.sin(a);
    return { e: trueScale * (c*h.e - s*h.n), n: trueScale * (s*h.e + c*h.n) };
  };
  const splats = [[3, 1, 0.2], [-2, 4, -0.5], [1, -3, 0.1], [5, 2, 0.3]];
  // цілі на карті = істинна проєкція відносно якоря
  const targets = splats.map((p) => {
    const m = project(p);
    return [lng0 + m.e / mPerLng, lat0 + m.n / mPerLat];
  });

  // --- те, що робить applyAlign, стартуючи з "сирої" сцени scale=1, rz=0 ---
  const scLng = lng0, scLat = lat0;      // якір близько до цілей (як у реальному UI)
  const srcPts = [], dstPts = [];
  for (let i = 0; i < splats.length; i++){
    const h = levelHorizontal(splats[i], rx, ry);
    srcPts.push({ x: h.e, y: h.n });
    dstPts.push({ x: (targets[i][0] - scLng) * mPerLng, y: (targets[i][1] - scLat) * mPerLat });
  }
  const sim = similarity2D(srcPts, dstPts);
  const wrap180 = (v) => ((v + 180) % 360 + 360) % 360 - 180;
  const newScale = sim.scale;
  const newRz = wrap180(sim.angleDeg);
  const newLng = scLng + sim.tx / mPerLng;
  const newLat = scLat + sim.ty / mPerLat;

  assert.ok(Math.abs(newScale - trueScale) < 1e-6, `scale ${newScale} != ${trueScale}`);
  assert.ok(Math.abs(wrap180(newRz - trueRz)) < 1e-6, `rz ${newRz} != ${trueRz}`);
  assert.ok(sim.rms < 1e-6, `rms ${sim.rms} завеликий`);

  // головна перевірка: кожен сплат під ВІДНОВЛЕНИМ перетворенням лягає на ціль
  for (let i = 0; i < splats.length; i++){
    const h = levelHorizontal(splats[i], rx, ry);
    const a = newRz * D, c = Math.cos(a), s = Math.sin(a);
    const e = newScale * (c*h.e - s*h.n), n = newScale * (s*h.e + c*h.n);
    const gotLng = newLng + e / mPerLng, gotLat = newLat + n / mPerLat;
    const errM = Math.hypot((gotLng - targets[i][0]) * mPerLng, (gotLat - targets[i][1]) * mPerLat);
    assert.ok(errM < 1e-3, `сплат ${i}: похибка ${errM} м завелика`);
  }
});
