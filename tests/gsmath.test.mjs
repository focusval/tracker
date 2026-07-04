// Тести чистої математики: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import {
  f2u, toHalf, pack2h, mat4mul, covFrom, centerCloud, buildTexData,
  rotationFromEuler, enuMatrix, cropKeeps, filterCrop,
} from "../js/gsmath.js";

function halfToFloat(h){
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

test("toHalf: відомі значення", () => {
  assert.equal(toHalf(0), 0);
  assert.equal(toHalf(1), 0x3c00);
  assert.equal(toHalf(-2), 0xc000);
  assert.equal(toHalf(65504), 0x7bff);   // максимум half
  assert.equal(toHalf(1e6), 0x7c00);     // переповнення → +inf
  assert.equal(toHalf(-1e6), 0xfc00);
  assert.equal(toHalf(Infinity), 0x7c00);
  assert.equal(toHalf(2 ** -24), 1);     // найменший субнормал
  assert.equal(toHalf(1e-12), 0);        // занадто мале → 0
});

test("toHalf: перенос каррі при округленні мантиси", () => {
  // 8191.998 лежить упритул під 2^13: мантиса округлюється з переповненням,
  // каррі мусить збільшити експоненту → 8192, а не 4096
  assert.equal(toHalf(8191.998), 0x7000);
  assert.equal(halfToFloat(toHalf(8191.998)), 8192);
  assert.equal(toHalf(65505), 0x7bff);   // без хибного каррі в inf
  assert.equal(halfToFloat(toHalf(2047.9995)), 2048);
});

test("toHalf: відносна похибка на випадкових значеннях", () => {
  for (let i = 0; i < 2000; i++){
    const v = (Math.random() * 2 - 1) * 10 ** (Math.random() * 8 - 4);
    const back = halfToFloat(toHalf(v));
    assert.ok(Math.abs(back - v) <= Math.abs(v) * 1.5e-3 + 1e-7,
      `v=${v} back=${back}`);
  }
});

test("pack2h пакує два half у uint32", () => {
  const p = pack2h(1.5, -0.25);
  assert.equal(p & 0xffff, toHalf(1.5));
  assert.equal(p >>> 16, toHalf(-0.25));
  assert.ok(p >= 0);
});

test("f2u — бітове представлення float32", () => {
  assert.equal(f2u(0), 0);
  assert.equal(f2u(1), 0x3f800000);
  assert.equal(f2u(-2), 0xc0000000);
});

test("mat4mul: збіг із наївним множенням і одинична матриця", () => {
  const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const rnd = () => Array.from({ length: 16 }, () => Math.random() * 4 - 2);
  const a = rnd(), b = rnd();
  const naive = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++)
        naive[c*4 + r] += a[k*4 + r] * b[c*4 + k];
  const got = mat4mul(a, b);
  for (let i = 0; i < 16; i++)
    assert.ok(Math.abs(got[i] - naive[i]) < 1e-5, `i=${i}`);
  assert.deepEqual([...mat4mul(I, b)].map((v) => +v.toFixed(5)),
    b.map((v) => +Math.fround(v).toFixed(5)));
});

test("covFrom: збіг із наївним Σ = (R·S)·(R·S)ᵀ", () => {
  for (let iter = 0; iter < 200; iter++){
    let [w, x, y, z] = [Math.random()-.5, Math.random()-.5, Math.random()-.5, Math.random()-.5];
    const qn = Math.hypot(w, x, y, z) || 1;
    w /= qn; x /= qn; y /= qn; z /= qn;
    const sx = Math.random()*2 + .01, sy = Math.random()*2 + .01, sz = Math.random()*2 + .01;
    const R = [
      [1-2*(y*y+z*z), 2*(x*y-w*z), 2*(x*z+w*y)],
      [2*(x*y+w*z), 1-2*(x*x+z*z), 2*(y*z-w*x)],
      [2*(x*z-w*y), 2*(y*z+w*x), 1-2*(x*x+y*y)],
    ];
    const S = [sx, sy, sz];
    const M = R.map((row) => row.map((v, j) => v * S[j]));
    const Sig = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++)
          Sig[i][j] += M[i][k] * M[j][k];
    const out = new Float32Array(6);
    covFrom(sx, sy, sz, w, x, y, z, out, 0);
    const expect = [Sig[0][0], Sig[0][1], Sig[0][2], Sig[1][1], Sig[1][2], Sig[2][2]];
    for (let i = 0; i < 6; i++)
      assert.ok(Math.abs(out[i] - expect[i]) < 1e-5, `iter=${iter} i=${i}`);
  }
});

test("centerCloud: центроїд стає нулем, NaN ігнорується у сумі", () => {
  const d = {
    count: 4,
    pos: new Float32Array([0,0,0, 2,4,6, 4,8,12, NaN,1,1]),
  };
  centerCloud(d);
  // центроїд трьох скінченних точок = (2,4,6)
  assert.deepEqual([...d.pos.slice(0, 9)], [-2,-4,-6, 0,0,0, 2,4,6]);
  assert.ok(Number.isNaN(d.pos[9]));
  assert.equal(d.pos[10], 1 - 4);
});

test("centerCloud: порожня хмара не падає", () => {
  const d = { count: 0, pos: new Float32Array(0) };
  centerCloud(d);
  assert.equal(d.count, 0);
});

test("rotationFromEuler: ортонормованість і базові кути", () => {
  const R = rotationFromEuler(33, -71, 118);
  // рядки ортонормовані
  for (let i = 0; i < 3; i++){
    const len = Math.hypot(R[i*3], R[i*3+1], R[i*3+2]);
    assert.ok(Math.abs(len - 1) < 1e-12);
  }
  // Rz(90): x → y
  const Rz = rotationFromEuler(0, 0, 90);
  const v = [Rz[0], Rz[3], Rz[6]]; // R·(1,0,0) = перший стовпець
  assert.ok(Math.abs(v[0]) < 1e-12 && Math.abs(v[1] - 1) < 1e-12 && Math.abs(v[2]) < 1e-12);
  // Rx(90): y → z
  const Rx = rotationFromEuler(90, 0, 0);
  const u = [Rx[1], Rx[4], Rx[7]]; // R·(0,1,0) = другий стовпець
  assert.ok(Math.abs(u[0]) < 1e-12 && Math.abs(u[1]) < 1e-12 && Math.abs(u[2] - 1) < 1e-12);
});

test("cropKeeps: еліпс і діапазон висот", () => {
  const crop = { rx: 25, ry: 50, hmin: -10, hmax: 10 };
  assert.equal(cropKeeps(crop, 20, 0, 0), true);
  assert.equal(cropKeeps(crop, 26, 0, 0), false);
  assert.equal(cropKeeps(crop, 0, 40, 0), true);
  assert.equal(cropKeeps(crop, 0, 51, 0), false);
  assert.equal(cropKeeps(crop, 20, 40, 0), false); // (0.8² + 0.8²) > 1
  assert.equal(cropKeeps(crop, 0, 0, 10), true);
  assert.equal(cropKeeps(crop, 0, 0, 11), false);
  assert.equal(cropKeeps(crop, 0, 0, -11), false);
});

test("filterCrop: масштаб множить локальні метри", () => {
  const pos = new Float32Array([10,0,0, 13,0,0, 0,20,0, 0,0,6]);
  const params = { rx: 0, ry: 0, rz: 0, scale: 2 };
  const crop = { rx: 25, ry: 50, hmin: -10, hmax: 10 };
  // ENU: (20,0,0) ✓; (26,0,0) ✗; (0,40,0) ✓; (0,0,12) ✗ по висоті
  assert.deepEqual(filterCrop(pos, 4, params, crop), [0, 2]);
});

test("filterCrop: поворот rz=90 обертає схід у північ", () => {
  const pos = new Float32Array([10,0,0, 0,10,0]);
  const params = { rx: 0, ry: 0, rz: 90, scale: 1 };
  const crop = { rx: 5, ry: 15, hmin: -10, hmax: 10 };
  // (10,0,0) → ENU (0,10,0): всередині; (0,10,0) → (-10,0,0): за межами rx=5
  assert.deepEqual(filterCrop(pos, 2, params, crop), [0]);
});

test("enuMatrix узгоджена з rotationFromEuler і scale", () => {
  const p = { rx: 20, ry: -40, rz: 75, scale: 3.5 };
  const R = rotationFromEuler(p.rx, p.ry, p.rz);
  const M = enuMatrix(p);
  for (let i = 0; i < 9; i++)
    assert.ok(Math.abs(M[i] - R[i] * 3.5) < 1e-12);
});

test("buildTexData: упаковка текселів", () => {
  const d = {
    count: 1,
    pos: new Float32Array([1, 2, 3]),
    cov: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]),
    col: new Uint8Array([10, 20, 30, 40]),
  };
  const { tex, height } = buildTexData(d);
  assert.equal(height, 1);
  assert.equal(tex.length, 2048 * 4);
  assert.equal(tex[0], f2u(1));
  assert.equal(tex[1], f2u(2));
  assert.equal(tex[2], f2u(3));
  assert.equal(tex[3], (10 | (20 << 8) | (30 << 16) | (40 << 24)) >>> 0);
  assert.equal(tex[4], pack2h(0.1, 0.2));
  assert.equal(tex[5], pack2h(0.3, 0.4));
  assert.equal(tex[6], pack2h(0.5, 0.6));
  assert.equal(tex[7], 0);
});

test("buildTexData: висота текстури росте з кількістю сплатів", () => {
  const n = 1500; // > 1024 → 2 рядки
  const d = {
    count: n,
    pos: new Float32Array(n * 3),
    cov: new Float32Array(n * 6),
    col: new Uint8Array(n * 4),
  };
  const { height, tex } = buildTexData(d);
  assert.equal(height, 2);
  assert.equal(tex.length, 2048 * 2 * 4);
});
