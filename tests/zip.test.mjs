// Тести ZIP-генератора (store) і CRC32: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { crc32, makeZip } from "../js/zip.js";

test("crc32: відомі вектори", () => {
  assert.equal(crc32(new TextEncoder().encode("")), 0);
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new TextEncoder().encode("The quick brown fox jumps over the lazy dog")), 0x414fa339);
});

test("makeZip: структура store-архіву читається як валідний ZIP", async () => {
  const files = [
    { name: "hello.txt", data: new TextEncoder().encode("Привіт світ") },
    { name: "scenes/a.splat", data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
  ];
  const blob = makeZip(files);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);

  // перший локальний заголовок
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint16(8, true), 0, "метод має бути store (0)");

  // EOCD у кінці
  const eocd = buf.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  assert.equal(dv.getUint16(eocd + 10, true), 2, "два записи в каталозі");

  // центральний каталог: сигнатури та імена файлів на місці
  const centralOffset = dv.getUint32(eocd + 16, true);
  assert.equal(dv.getUint32(centralOffset, true), 0x02014b50);
});

test("makeZip: дані і CRC у локальному заголовку відповідають вмісту", async () => {
  const payload = new Uint8Array(1000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) & 0xff;
  const blob = makeZip([{ name: "d.bin", data: payload }]);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);

  const nameLen = dv.getUint16(26, true);
  const crcStored = dv.getUint32(14, true);
  const sizeStored = dv.getUint32(22, true);
  assert.equal(sizeStored, payload.length);
  assert.equal(crcStored, crc32(payload));

  // самі байти лежать одразу після заголовка (30 + ім'я) без стиснення
  const dataStart = 30 + nameLen;
  const stored = buf.slice(dataStart, dataStart + payload.length);
  assert.deepEqual([...stored], [...payload]);
});

test("makeZip: порожній список → валідний порожній архів", async () => {
  const buf = new Uint8Array(await makeZip([]).arrayBuffer());
  assert.equal(buf.length, 22); // лише EOCD
  const dv = new DataView(buf.buffer);
  assert.equal(dv.getUint32(0, true), 0x06054b50);
  assert.equal(dv.getUint16(10, true), 0);
});
