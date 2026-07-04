// Воркер сортування сплатів back-to-front: глибина = -(рядок w MVP · позиція),
// лічильне сортування на 65536 кошиків. Позиції кожної сцени передаються
// один раз повідомленням {type:"add"}.
const scenes = {};
onmessage = (e) => {
  const d = e.data;
  if (d.type === "add") { scenes[d.id] = new Float32Array(d.positions); return; }
  if (d.type === "remove") { delete scenes[d.id]; return; }
  if (d.type !== "sort") return;
  const f = scenes[d.id]; if (!f) return;
  const n = f.length / 3;
  const r0 = d.row[0], r1 = d.row[1], r2 = d.row[2];
  let min = Infinity, max = -Infinity;
  const size = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const depth = (-(r0*f[3*i] + r1*f[3*i+1] + r2*f[3*i+2]) * 4096) | 0;
    size[i] = depth;
    if (depth > max) max = depth; if (depth < min) min = depth;
  }
  const inv = 65535 / ((max - min) || 1);
  const counts = new Uint32Array(65536);
  for (let i = 0; i < n; i++) { size[i] = ((size[i]-min)*inv)|0; counts[size[i]]++; }
  const starts = new Uint32Array(65536);
  for (let i = 1; i < 65536; i++) starts[i] = starts[i-1] + counts[i-1];
  const index = new Uint32Array(n);
  for (let i = 0; i < n; i++) index[starts[size[i]]++] = i;
  postMessage({ id: d.id, index }, [index.buffer]);
};
