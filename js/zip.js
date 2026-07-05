// Мінімальний генератор ZIP без залежностей: метод "store" (без стиснення —
// .splat уже компактний бінарник, стиснення дало б крихти). Достатньо для
// експорту повноцінного сайту-карти одним архівом.

// CRC-32 (IEEE 802.3), таблиця будується один раз.
let CRC_TABLE = null;
function crcTable(){
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(bytes){
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Кодування дати/часу у формат MS-DOS (потрібне ZIP-заголовку).
function dosDateTime(date){
  const d = date || new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const dt = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: dt & 0xffff };
}

// files: [{ name: "path/in/zip", data: Uint8Array }]. Повертає Blob (application/zip).
export function makeZip(files, when){
  const { time, date } = dosDateTime(when);
  const enc = new TextEncoder();
  const locals = [];   // локальні заголовки + дані
  const centrals = []; // елементи центрального каталогу
  let offset = 0;

  for (const f of files){
    const nameBytes = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc = crc32(data);
    const size = data.length;

    // локальний заголовок файлу (30 байт + ім'я)
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // сигнатура
    lv.setUint16(4, 20, true);           // версія для розпакування
    lv.setUint16(6, 0, true);            // прапорці
    lv.setUint16(8, 0, true);            // метод 0 = store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);        // стиснутий розмір
    lv.setUint32(22, size, true);        // початковий розмір
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // довжина extra
    local.set(nameBytes, 30);
    locals.push(local, data);

    // елемент центрального каталогу (46 байт + ім'я)
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);           // версія, якою створено
    cv.setUint16(6, 20, true);           // версія для розпакування
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);           // метод store
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);           // extra
    cv.setUint16(32, 0, true);           // коментар
    cv.setUint16(34, 0, true);           // № диска
    cv.setUint16(36, 0, true);           // внутрішні атрибути
    cv.setUint32(38, 0, true);           // зовнішні атрибути
    cv.setUint32(42, offset, true);      // зсув локального заголовка
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const centralOffset = offset;

  // кінець центрального каталогу (EOCD, 22 байти)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);

  return new Blob([...locals, ...centrals, eocd], { type: "application/zip" });
}
