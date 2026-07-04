// Тести авто-рівня (визначення площини землі): node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { smallestEigenvector3, estimateLevel, rotationFromEuler } from "../js/gsmath.js";

// детермінований генератор, щоб тест не флейкав
function lcg(seed){
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

test("smallestEigenvector3: діагональна матриця", () => {
  const n = smallestEigenvector3([4, 0, 0, 2, 0, 0.5]);
  assert.ok(Math.abs(Math.abs(n[2]) - 1) < 1e-9, `очікував ±ez, отримав ${n}`);
  assert.ok(Math.abs(n[0]) < 1e-9 && Math.abs(n[1]) < 1e-9);
});

test("smallestEigenvector3: повернута матриця площини", () => {
  // коваріація тонкої площини з нормаллю u
  const u = [0.6, 0.64, 0.48]; // |u| = 1.0 (0.36+0.4096+0.2304)
  // C = I - u·uᵀ (розтяг у площині, майже нуль уздовж u)
  const C = [
    1 - u[0]*u[0], -u[0]*u[1], -u[0]*u[2],
    1 - u[1]*u[1], -u[1]*u[2], 1 - u[2]*u[2],
  ];
  const n = smallestEigenvector3(C);
  const dot = Math.abs(n[0]*u[0] + n[1]*u[1] + n[2]*u[2]);
  assert.ok(dot > 0.9999, `нормаль не збіглася: dot=${dot}`);
});

test("estimateLevel: знаходить нахил і висоту нахиленої сцени", () => {
  const rnd = lcg(42);
  const rx0 = 25, ry0 = -40, rz0 = 77;
  const R = rotationFromEuler(rx0, ry0, rz0);
  const groundZ = 3; // земля у «світі» на висоті 3 м
  const N = 4000;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++){
    const wx = (rnd() * 2 - 1) * 60;
    const wy = (rnd() * 2 - 1) * 60;
    // 75% точок — земля з дрібним шумом, 25% — «будівлі» над землею
    const wz = groundZ + (rnd() < 0.75 ? (rnd() - 0.5) * 0.4 : rnd() * 25);
    // локальні координати: p = Rᵀ·w, тоді R·p повертає світ назад
    pos[i*3]   = R[0]*wx + R[3]*wy + R[6]*wz;
    pos[i*3+1] = R[1]*wx + R[4]*wy + R[7]*wz;
    pos[i*3+2] = R[2]*wx + R[5]*wy + R[8]*wz;
  }
  const est = estimateLevel(pos, N, { rx: 0, ry: 0, rz: 0, scale: 2 }, null);
  assert.ok(est, "estimateLevel повернув null");
  // нормаль з оцінених кутів має збігтися зі світовим «вгору» (третій рядок R)
  const Re = rotationFromEuler(est.rx, est.ry, 0);
  const nEst = [Re[6], Re[7], Re[8]];
  const nTrue = [R[6], R[7], R[8]];
  const dot = nEst[0]*nTrue[0] + nEst[1]*nTrue[1] + nEst[2]*nTrue[2];
  assert.ok(dot > 0.999, `нормаль розійшлася: dot=${dot}, est=(${est.rx}, ${est.ry})`);
  // висота: земля на 3 м, масштаб 2 → alt ≈ −6
  assert.ok(Math.abs(est.alt - (-2 * groundZ)) < 1.5, `alt=${est.alt}, очікував ≈ −6`);
});

test("estimateLevel: рівна сцена лишається рівною", () => {
  const rnd = lcg(7);
  const N = 2000;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++){
    pos[i*3] = (rnd() * 2 - 1) * 50;
    pos[i*3+1] = (rnd() * 2 - 1) * 50;
    pos[i*3+2] = rnd() < 0.8 ? (rnd() - 0.5) * 0.3 : rnd() * 20;
  }
  const est = estimateLevel(pos, N, { rx: 0, ry: 0, rz: 0, scale: 1 }, null);
  assert.ok(est);
  assert.ok(Math.abs(est.rx) < 2 && Math.abs(est.ry) < 2,
    `сцена вже рівна, а кути (${est.rx}, ${est.ry})`);
  assert.ok(Math.abs(est.alt) < 1, `alt=${est.alt}, очікував ≈ 0`);
});

test("estimateLevel: фільтр обрізки відсікає сторонні точки", () => {
  const rnd = lcg(99);
  const N = 3000;
  const pos = new Float32Array(N * 3);
  // рівна земля в радіусі 30 м + «сфера неба» радіусом 300 м навколо
  for (let i = 0; i < N; i++){
    if (i % 3 < 2){
      pos[i*3] = (rnd() * 2 - 1) * 30;
      pos[i*3+1] = (rnd() * 2 - 1) * 30;
      pos[i*3+2] = (rnd() - 0.5) * 0.4;
    } else {
      const a = rnd() * Math.PI * 2, b = Math.acos(rnd() * 2 - 1);
      pos[i*3] = 300 * Math.sin(b) * Math.cos(a);
      pos[i*3+1] = 300 * Math.sin(b) * Math.sin(a);
      pos[i*3+2] = 300 * Math.cos(b);
    }
  }
  const params = { rx: 0, ry: 0, rz: 0, scale: 1 };
  const crop = { rx: 50, ry: 50, hmin: -20, hmax: 20 };
  const est = estimateLevel(pos, N, params, crop);
  assert.ok(est);
  assert.ok(Math.abs(est.rx) < 3 && Math.abs(est.ry) < 3,
    `обрізка мала лишити рівну землю, а кути (${est.rx}, ${est.ry})`);
});

test("estimateLevel: null при замалій вибірці", () => {
  assert.equal(estimateLevel(new Float32Array(30), 10, { rx:0, ry:0, rz:0, scale:1 }, null), null);
});
