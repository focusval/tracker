// Тести парсерів .ply/.splat і запису .splat: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { parseSplatFile, parsePlyFile, writeSplat } from "../js/formats.js";
import { covFrom } from "../js/gsmath.js";

// ── синтетичний бінарний gaussian-PLY ──

function buildPly(props, rows, { format = "binary_little_endian" } = {}){
  const header =
    "ply\n" +
    `format ${format} 1.0\n` +
    `element vertex ${rows.length}\n` +
    props.map((p) => `property ${p.type} ${p.name}`).join("\n") +
    "\nend_header\n";
  const hb = new TextEncoder().encode(header);
  const sizes = { float: 4, double: 8, uchar: 1, int: 4, short: 2 };
  const stride = props.reduce((s, p) => s + sizes[p.type], 0);
  const body = new ArrayBuffer(rows.length * stride);
  const dv = new DataView(body);
  rows.forEach((row, i) => {
    let off = i * stride;
    props.forEach((p) => {
      const v = row[p.name];
      if (p.type === "float") dv.setFloat32(off, v, true);
      else if (p.type === "double") dv.setFloat64(off, v, true);
      else if (p.type === "uchar") dv.setUint8(off, v);
      else if (p.type === "short") dv.setInt16(off, v, true);
      else dv.setInt32(off, v, true);
      off += sizes[p.type];
    });
  });
  const out = new Uint8Array(hb.length + body.byteLength);
  out.set(hb, 0);
  out.set(new Uint8Array(body), hb.length);
  return out.buffer;
}

const GPROPS = ["x","y","z","f_dc_0","f_dc_1","f_dc_2","opacity",
  "scale_0","scale_1","scale_2","rot_0","rot_1","rot_2","rot_3"]
  .map((name) => ({ name, type: "float" }));

const SH = 0.28209479177387814;
const sigmoid = (v) => 255 / (1 + Math.exp(-v));
const c255 = (v) => Math.max(0, Math.min(255, v)) | 0;

test("parsePlyFile: gaussian-PLY — позиції, кольори, масштаби, кватерніони, коваріація", () => {
  const rows = [
    { x: 1, y: 2, z: 3, f_dc_0: 0.5, f_dc_1: -0.3, f_dc_2: 1.9, opacity: 2.0,
      scale_0: Math.log(0.5), scale_1: Math.log(1.5), scale_2: Math.log(0.05),
      rot_0: 2, rot_1: 0, rot_2: 0, rot_3: 0 },
    { x: -4, y: 0, z: 9.25, f_dc_0: -3, f_dc_1: 0, f_dc_2: 0.1, opacity: -2.0,
      scale_0: Math.log(1), scale_1: Math.log(1), scale_2: Math.log(1),
      rot_0: 1, rot_1: 1, rot_2: 0, rot_3: 0 },
  ];
  const d = parsePlyFile(buildPly(GPROPS, rows));
  assert.equal(d.count, 2);
  assert.deepEqual([...d.pos], [1, 2, 3, -4, 0, 9.25]);
  // масштаби: exp(log s) = s
  assert.ok(Math.abs(d.scl[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(d.scl[1] - 1.5) < 1e-6);
  assert.ok(Math.abs(d.scl[2] - 0.05) < 1e-6);
  // кватерніон нормалізується: (2,0,0,0) → (1,0,0,0); (1,1,0,0) → (√½,√½,0,0)
  assert.equal(d.rot[0], 1);
  assert.ok(Math.abs(d.rot[4] - Math.SQRT1_2) < 1e-6);
  assert.ok(Math.abs(d.rot[5] - Math.SQRT1_2) < 1e-6);
  // кольори: SH → RGB, opacity → сигмоїда
  assert.equal(d.col[0], c255((0.5 + SH * 0.5) * 255));
  assert.equal(d.col[1], c255((0.5 + SH * -0.3) * 255));
  assert.equal(d.col[2], c255((0.5 + SH * 1.9) * 255)); // кламп до 255
  assert.equal(d.col[3], c255(sigmoid(2)));
  assert.equal(d.col[4], 0); // (0.5 + SH*(-3)) < 0 → кламп до 0
  // коваріація узгоджена з covFrom від розпарсених scl/rot
  const expect = new Float32Array(6);
  covFrom(d.scl[0], d.scl[1], d.scl[2], d.rot[0], d.rot[1], d.rot[2], d.rot[3], expect, 0);
  for (let i = 0; i < 6; i++) assert.equal(d.cov[i], expect[i]);
});

test("parsePlyFile: хмара точок (без scale_0) — колір із red/green/blue", () => {
  const props = [
    { name: "x", type: "float" }, { name: "y", type: "float" }, { name: "z", type: "float" },
    { name: "red", type: "uchar" }, { name: "green", type: "uchar" }, { name: "blue", type: "uchar" },
  ];
  const d = parsePlyFile(buildPly(props, [{ x: 5, y: 6, z: 7, red: 11, green: 22, blue: 33 }]));
  assert.equal(d.count, 1);
  assert.deepEqual([...d.pos], [5, 6, 7]);
  assert.deepEqual([...d.col], [11, 22, 33, 255]);
  assert.ok(Math.abs(d.scl[0] - 0.03) < 1e-6);
  assert.equal(d.rot[0], 1);
  assert.ok(Math.abs(d.cov[0] - 0.0009) < 1e-6); // s²
  assert.equal(d.cov[1], 0);
});

test("parsePlyFile: змішані типи властивостей (double/short у страйді)", () => {
  const props = [
    { name: "x", type: "float" }, { name: "y", type: "double" }, { name: "z", type: "float" },
    { name: "extra", type: "short" },
    { name: "red", type: "uchar" }, { name: "green", type: "uchar" }, { name: "blue", type: "uchar" },
  ];
  const d = parsePlyFile(buildPly(props, [{ x: 1.5, y: 2.5, z: -3.5, extra: 7, red: 1, green: 2, blue: 3 }]));
  assert.deepEqual([...d.pos], [1.5, 2.5, -3.5]);
  assert.deepEqual([...d.col], [1, 2, 3, 255]);
});

test("parsePlyFile: помилки — не PLY, ASCII, списки", () => {
  assert.throws(() => parsePlyFile(new TextEncoder().encode("не ply зовсім").buffer),
    /Це не PLY-файл/);
  assert.throws(() => parsePlyFile(buildPly(GPROPS, [], { format: "ascii" })),
    /binary_little_endian/);
  const listHeader = "ply\nformat binary_little_endian 1.0\nelement vertex 1\n" +
    "property list uchar int vertex_indices\nend_header\n";
  assert.throws(() => parsePlyFile(new TextEncoder().encode(listHeader).buffer),
    /списками не підтримується/);
});

// ── .splat: запис → читання → ті самі значення ──

function makeData(){
  const count = 3;
  const pos = new Float32Array([0.5, -1.25, 3, 10, 20, 30, -7, 0, 0.125]);
  const scl = new Float32Array([0.5, 0.5, 0.5, 1, 2, 3, 0.05, 0.05, 4]);
  const col = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 12, 34, 56, 78]);
  const rot = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0.6, 0.8, 0, 0]);
  const cov = new Float32Array(count * 6);
  for (let i = 0; i < count; i++)
    covFrom(scl[i*3], scl[i*3+1], scl[i*3+2], rot[i*4], rot[i*4+1], rot[i*4+2], rot[i*4+3], cov, i*6);
  return { count, pos, scl, col, rot, cov };
}

test("writeSplat → parseSplatFile: round-trip", () => {
  const d = makeData();
  const buf = writeSplat(d);
  assert.equal(buf.byteLength, 3 * 32);
  const p = parseSplatFile(buf);
  assert.equal(p.count, 3);
  assert.deepEqual([...p.pos], [...d.pos]); // f32 → байти → f32 без втрат
  assert.deepEqual([...p.scl], [...d.scl]);
  assert.deepEqual([...p.col], [...d.col]);
  for (let i = 0; i < d.rot.length; i++)
    assert.ok(Math.abs(p.rot[i] - d.rot[i]) <= 1 / 64,
      `rot[${i}]: ${p.rot[i]} vs ${d.rot[i]}`); // квантизація u8 ±1/128 + нормалізація
  // коваріація відтворюється з квантизованих scl/rot
  const expect = new Float32Array(6);
  for (let i = 0; i < 3; i++){
    covFrom(p.scl[i*3], p.scl[i*3+1], p.scl[i*3+2], p.rot[i*4], p.rot[i*4+1], p.rot[i*4+2], p.rot[i*4+3], expect, 0);
    for (let j = 0; j < 6; j++) assert.equal(p.cov[i*6+j], expect[j]);
  }
});

test("writeSplat: стабільність позицій/кольорів при повторному циклі", () => {
  const d = makeData();
  const buf1 = writeSplat(d);
  const p1 = parseSplatFile(buf1);
  const buf2 = writeSplat(p1);
  const a = new Uint8Array(buf1), b = new Uint8Array(buf2);
  // позиції, масштаби, кольори — байт у байт
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 28; j++)
      assert.equal(a[i*32+j], b[i*32+j], `сплат ${i}, байт ${j}`);
  // кватерніони другого циклу — в межах ±1 кроку квантизації
  for (let i = 0; i < 3; i++)
    for (let j = 28; j < 32; j++)
      assert.ok(Math.abs(a[i*32+j] - b[i*32+j]) <= 1, `сплат ${i}, байт ${j}`);
});

test("writeSplat із keep: лишає вибрані сплати у вказаному порядку", () => {
  const d = makeData();
  const buf = writeSplat(d, [2, 0]);
  assert.equal(buf.byteLength, 2 * 32);
  const p = parseSplatFile(buf);
  assert.deepEqual([...p.pos.slice(0, 3)], [-7, 0, 0.125]);
  assert.deepEqual([...p.pos.slice(3, 6)], [0.5, -1.25, 3]);
  assert.deepEqual([...p.col.slice(0, 4)], [12, 34, 56, 78]);
});

test("parseSplatFile: хвіст, не кратний 32 байтам, ігнорується", () => {
  const d = makeData();
  const buf = writeSplat(d);
  const bigger = new Uint8Array(buf.byteLength + 5);
  bigger.set(new Uint8Array(buf), 0);
  const p = parseSplatFile(bigger.buffer);
  assert.equal(p.count, 3);
  assert.deepEqual([...p.pos], [...d.pos]);
});

test("parseSplatFile: порожній буфер → нуль сплатів", () => {
  const p = parseSplatFile(new ArrayBuffer(0));
  assert.equal(p.count, 0);
  assert.equal(p.pos.length, 0);
});
