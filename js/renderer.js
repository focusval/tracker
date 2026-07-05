// Рендерер гаусових сплатів: кастомний WebGL2-шар MapLibre.
// Дані сплатів — у текстурі RGBA32UI (2 текселі/сплат), інстансинг квадів
// TRIANGLE_STRIP, екранна 2D-коваріація через скінченні різниці від повної MVP,
// сортування back-to-front у воркері, premultiplied alpha поверх карти.
// Шейдери та математика — перевірена референсна реалізація, не змінювати.

import { mat4mul, buildTexData, rotationFromEuler } from "./gsmath.js";

const VERT = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform highp usampler2D uTex;
uniform mat4 uMVP;      // = matrix(MapLibre) x model, перемножено на CPU у double
uniform vec2 uViewport; // drawingBufferWidth/Height
uniform mat3 uEnu;      // локальна позиція -> метри схід/північ/вгору (scale*R)
uniform vec4 uCrop;     // rx, ry, hmin, hmax
uniform bool uCropOn;
uniform bool uCropRect; // false = еліпс, true = прямокутник
uniform vec2 uCropRot;  // (cos, sin) кута повороту обрізки
layout(location=0) in vec2 aCorner;  // квад (-2,-2),(2,-2),(-2,2),(2,2)
layout(location=1) in uint aIndex;   // інстансний атрибут: відсортований індекс
out vec4 vColor; out vec2 vPos;
void main() {
  ivec2 uv0 = ivec2(int((aIndex & 1023u) << 1), int(aIndex >> 10));
  uvec4 t0 = texelFetch(uTex, uv0, 0);
  vec3 p = uintBitsToFloat(t0.xyz);
  if (uCropOn) {
    vec3 m = uEnu * p;
    // поворот площини обрізки на -rot (uCropRot = cos,sin прямого кута)
    vec2 mr = vec2(uCropRot.x * m.x + uCropRot.y * m.y,
                  -uCropRot.y * m.x + uCropRot.x * m.y);
    bool outside;
    if (uCropRect) {
      outside = abs(mr.x) > uCrop.x || abs(mr.y) > uCrop.y;
    } else {
      vec2 q = mr / uCrop.xy;
      outside = dot(q, q) > 1.0;
    }
    if (outside || m.z < uCrop.z || m.z > uCrop.w) {
      gl_Position = vec4(0.,0.,2.,1.); return;
    }
  }
  vec4 c0 = uMVP * vec4(p, 1.0);
  if (c0.w <= 0.0) { gl_Position = vec4(0.,0.,2.,1.); return; }
  vec2 ndc = c0.xy / c0.w;
  if (abs(ndc.x) > 1.3 || abs(ndc.y) > 1.3) { gl_Position = vec4(0.,0.,2.,1.); return; }
  vec4 cx = uMVP * vec4(p + vec3(1.,0.,0.), 1.0);
  vec4 cy = uMVP * vec4(p + vec3(0.,1.,0.), 1.0);
  vec4 cz = uMVP * vec4(p + vec3(0.,0.,1.), 1.0);
  vec2 hv = 0.5 * uViewport;
  mat3x2 A = mat3x2((cx.xy/cx.w - ndc)*hv, (cy.xy/cy.w - ndc)*hv, (cz.xy/cz.w - ndc)*hv);
  uvec4 t1 = texelFetch(uTex, ivec2(uv0.x | 1, uv0.y), 0);
  vec2 h1 = unpackHalf2x16(t1.x); vec2 h2 = unpackHalf2x16(t1.y); vec2 h3 = unpackHalf2x16(t1.z);
  mat3 V = mat3(h1.x,h1.y,h2.x, h1.y,h2.y,h3.x, h2.x,h3.x,h3.y);
  mat2 cov = A * (V * transpose(A));
  cov[0][0] += 0.3; cov[1][1] += 0.3;
  float mid = 0.5*(cov[0][0]+cov[1][1]);
  float rad = length(vec2(0.5*(cov[0][0]-cov[1][1]), cov[0][1]));
  float l1 = mid + rad; float l2 = max(mid - rad, 0.1);
  if (l1 < 0.05) { gl_Position = vec4(0.,0.,2.,1.); return; }
  vec2 dir = normalize(vec2(cov[0][1], l1 - cov[0][0] + 1e-6));
  vec2 major = min(sqrt(2.0*l1), 1024.0) * dir;
  vec2 minor = min(sqrt(2.0*l2), 1024.0) * vec2(dir.y, -dir.x);
  vColor = vec4(float(t0.w & 255u), float((t0.w>>8)&255u), float((t0.w>>16)&255u), float(t0.w>>24)) / 255.0;
  vPos = aCorner;
  gl_Position = vec4(ndc + (aCorner.x*major + aCorner.y*minor)/hv, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec4 vColor; in vec2 vPos;
out vec4 fragColor;
void main() {
  float A = -dot(vPos, vPos);
  if (A < -4.0) discard;
  float B = exp(A) * vColor.a;
  fragColor = vec4(B * vColor.rgb, B); // premultiplied
}`;

export class SplatLayer {
  constructor(){
    this.id = "splats";
    this.type = "custom";
    this.renderingMode = "3d";
    this.scenes = new Map();
    this.map = null;
    this.gl = null;
    this.program = null;
    this.onError = null; // (українське повідомлення) -> void
    this.onErase = null; // (id, mask, hit, total) -> void — після мазка гумки
    this.onPick = null;  // (id, tag, pos|null) -> void — після вибору точки
    this.lastMatrix = null; // остання проєкційна матриця карти (для гумки/вибору)
    this.worker = new Worker(new URL("./sorter.worker.js", import.meta.url));
    this.worker.onmessage = (e) => {
      if (e.data.erased) this._onErased(e.data);
      else if (e.data.picked) this._onPicked(e.data);
      else this._onSorted(e.data);
    };
  }

  onAdd(map, gl){
    this.map = map;
    if (typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext)) {
      if (this.onError) this.onError("Цей браузер не підтримує WebGL2 — сплати не відобразяться.");
      return;
    }
    this.gl = gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
        throw new Error("Помилка компіляції шейдера: " + gl.getShaderInfoLog(sh));
      return sh;
    };
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
        throw new Error("Помилка лінковки програми: " + gl.getProgramInfoLog(prog));
      this.program = prog;
    } catch (err) {
      if (this.onError) this.onError(String(err.message || err));
      return;
    }
    this.u = {
      tex: gl.getUniformLocation(this.program, "uTex"),
      mvp: gl.getUniformLocation(this.program, "uMVP"),
      viewport: gl.getUniformLocation(this.program, "uViewport"),
      enu: gl.getUniformLocation(this.program, "uEnu"),
      crop: gl.getUniformLocation(this.program, "uCrop"),
      cropOn: gl.getUniformLocation(this.program, "uCropOn"),
      cropRect: gl.getUniformLocation(this.program, "uCropRect"),
      cropRot: gl.getUniformLocation(this.program, "uCropRot"),
    };
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2,-2, 2,-2, -2,2, 2,2]), gl.STATIC_DRAW);
    for (const sc of this.scenes.values()) if (!sc.vao) this._initSceneGL(sc);
  }

  onRemove(){
    const gl = this.gl;
    if (gl) {
      for (const sc of this.scenes.values()) this._freeSceneGL(sc);
      if (this.program) gl.deleteProgram(this.program);
      if (this.quadBuf) gl.deleteBuffer(this.quadBuf);
    }
    this.program = null; this.gl = null;
    this.worker.terminate();
  }

  // data — результат parseSplatFile/parsePlyFile; params — {lng,lat,alt,rx,ry,rz,scale};
  // crop — {on,rx,ry,hmin,hmax}. Дані після ініціалізації GL не зберігаються.
  addScene(id, data, params, visible, crop){
    this.removeScene(id);
    const sc = {
      id, count: data.count, data,
      params: {...params},
      crop: crop ? {...crop} : {on:false, shape:"ellipse", rot:0, rx:100, ry:100, hmin:-50, hmax:200},
      visible: visible !== false,
      model: new Float64Array(16),
      enu: new Float32Array(9),
      lastRow: [NaN, 0, 0],
      sorting: false,
      drawCount: data.count,
      texture: null, indexBuf: null, vao: null,
    };
    this.scenes.set(id, sc);
    this._rebuildModel(sc);
    const posCopy = data.pos.buffer.slice(0);
    this.worker.postMessage({ type: "add", id, positions: posCopy }, [posCopy]);
    if (this.gl && this.program) this._initSceneGL(sc);
    if (this.map) this.map.triggerRepaint();
    return sc;
  }

  removeScene(id){
    const sc = this.scenes.get(id);
    if (!sc) return;
    this._freeSceneGL(sc);
    this.scenes.delete(id);
    this.worker.postMessage({ type: "remove", id });
    if (this.map) this.map.triggerRepaint();
  }

  hasScene(id){ return this.scenes.has(id); }

  setParams(id, params){
    const sc = this.scenes.get(id);
    if (!sc) return;
    Object.assign(sc.params, params);
    this._rebuildModel(sc);
    if (this.map) this.map.triggerRepaint();
  }

  setCrop(id, crop){
    const sc = this.scenes.get(id);
    if (!sc) return;
    Object.assign(sc.crop, crop);
    if (this.map) this.map.triggerRepaint();
  }

  setVisible(id, v){
    const sc = this.scenes.get(id);
    if (!sc) return;
    sc.visible = !!v;
    if (this.map) this.map.triggerRepaint();
  }

  // Форсує пересортування (після зміни маски стертих сплатів).
  forceSort(id){
    const sc = this.scenes.get(id);
    if (!sc) return;
    sc.lastRow[0] = NaN;
    if (this.map) this.map.triggerRepaint();
  }

  // Мазок гумки: точки в CSS-пікселях канви карти, радіус у CSS-пікселях.
  // depthFrac: 0 = лише найближча поверхня (один бік), 1 = наскрізь.
  eraseStroke(id, pointsCss, rCss, depthFrac){
    const sc = this.scenes.get(id);
    if (!sc || !this.lastMatrix || !this.map) return;
    const canvas = this.map.getCanvas();
    const k = canvas.width / (canvas.clientWidth || 1);
    const mvp = mat4mul(this.lastMatrix, sc.model);
    this.worker.postMessage({
      type: "erase", id,
      mvp: Array.from(mvp),
      w: canvas.width, h: canvas.height,
      r: rCss * k,
      depthFrac: depthFrac == null ? 0.15 : depthFrac,
      points: pointsCss.map((p) => ({ x: p.x * k, y: p.y * k })),
    });
  }

  // Вибір найближчого сплата під екранною точкою (CSS-пікселі). Результат —
  // у колбеку onPick(id, tag, pos). tag дозволяє розрізняти запити.
  pickSplat(id, xCss, yCss, tag){
    const sc = this.scenes.get(id);
    if (!sc || !this.lastMatrix || !this.map) return;
    const canvas = this.map.getCanvas();
    const k = canvas.width / (canvas.clientWidth || 1);
    const mvp = mat4mul(this.lastMatrix, sc.model);
    this.worker.postMessage({
      type: "pick", id, tag,
      mvp: Array.from(mvp),
      w: canvas.width, h: canvas.height,
      x: xCss * k, y: yCss * k, r: 26 * k,
    });
  }

  // Світлова позиція локальної точки сцени → [lng, lat] на карті (для маркерів
  // прив'язки). Використовує модельну матрицю сцени й мерка тор MapLibre.
  localToLngLat(id, p){
    const sc = this.scenes.get(id);
    if (!sc) return null;
    const m = sc.model;
    const mx = m[0]*p[0] + m[4]*p[1] + m[8]*p[2] + m[12];
    const my = m[1]*p[0] + m[5]*p[1] + m[9]*p[2] + m[13];
    const mz = m[2]*p[0] + m[6]*p[1] + m[10]*p[2] + m[14];
    const mc = new maplibregl.MercatorCoordinate(mx, my, mz);
    const ll = mc.toLngLat();
    return [ll.lng, ll.lat];
  }

  _onPicked(msg){
    if (this.onPick) this.onPick(msg.id, msg.tag, msg.found ? msg.pos : null);
  }

  // Відновлення маски стертих (крок назад). mask — Uint8Array або null.
  setEraseMask(id, mask){
    this.worker.postMessage({ type: "setMask", id, mask: mask ? mask.slice().buffer : null });
    this.forceSort(id);
  }

  _onErased(msg){
    this.forceSort(msg.id);
    if (this.onErase) this.onErase(msg.id, new Uint8Array(msg.mask), msg.hit, msg.total);
  }

  _rebuildModel(sc){
    const p = sc.params;
    const mc = maplibregl.MercatorCoordinate.fromLngLat([p.lng, p.lat], p.alt);
    const k = mc.meterInMercatorCoordinateUnits() * p.scale;
    const [r00,r01,r02,r10,r11,r12,r20,r21,r22] = rotationFromEuler(p.rx, p.ry, p.rz);
    const m = sc.model; // column-major; вісь y меркатора інвертується
    m[0]=k*r00;  m[1]=-k*r10; m[2]=k*r20;  m[3]=0;
    m[4]=k*r01;  m[5]=-k*r11; m[6]=k*r21;  m[7]=0;
    m[8]=k*r02;  m[9]=-k*r12; m[10]=k*r22; m[11]=0;
    m[12]=mc.x; m[13]=mc.y; m[14]=mc.z; m[15]=1;
    // ENU для обрізки (scale*R), колонково-мажорно для uniformMatrix3fv
    const s = p.scale, e = sc.enu;
    e[0]=s*r00; e[1]=s*r10; e[2]=s*r20;
    e[3]=s*r01; e[4]=s*r11; e[5]=s*r21;
    e[6]=s*r02; e[7]=s*r12; e[8]=s*r22;
    sc.lastRow[0] = NaN; // форсує пересортування
  }

  _initSceneGL(sc){
    const gl = this.gl;
    const { tex, height } = buildTexData(sc.data);
    sc.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, sc.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, 2048, height, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, tex);
    const identity = new Uint32Array(sc.count);
    for (let i = 0; i < sc.count; i++) identity[i] = i;
    sc.indexBuf = gl.createBuffer();
    sc.vao = gl.createVertexArray();
    gl.bindVertexArray(sc.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, sc.indexBuf);
    gl.bufferData(gl.ARRAY_BUFFER, identity, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    sc.data = null; // сирі атрибути далі не потрібні рендереру
  }

  _freeSceneGL(sc){
    const gl = this.gl;
    if (!gl) return;
    if (sc.texture) gl.deleteTexture(sc.texture);
    if (sc.indexBuf) gl.deleteBuffer(sc.indexBuf);
    if (sc.vao) gl.deleteVertexArray(sc.vao);
    sc.texture = sc.indexBuf = sc.vao = null;
  }

  _onSorted(msg){
    const sc = this.scenes.get(msg.id);
    if (!sc) return;
    sc.sorting = false;
    const gl = this.gl;
    if (!gl || !sc.indexBuf) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, sc.indexBuf);
    gl.bufferData(gl.ARRAY_BUFFER, msg.index, gl.DYNAMIC_DRAW);
    sc.drawCount = msg.index.length;
    // якщо камера рухалась, поки йшло сортування — одразу запускаємо наступне,
    // не чекаючи кадру: порядок не відстає від руху
    if (this.lastMatrix){
      const mvp = mat4mul(this.lastMatrix, sc.model);
      const r0 = mvp[3], r1 = mvp[7], r2 = mvp[11];
      const L = sc.lastRow;
      const diff = Math.abs(r0-L[0]) + Math.abs(r1-L[1]) + Math.abs(r2-L[2]);
      const sum = Math.abs(r0) + Math.abs(r1) + Math.abs(r2);
      if (!(diff/sum <= 3e-4)){
        sc.sorting = true;
        L[0]=r0; L[1]=r1; L[2]=r2;
        this.worker.postMessage({ type: "sort", id: sc.id, row: [r0, r1, r2] });
      }
    }
    if (this.map) this.map.triggerRepaint();
  }

  render(gl, matrix){
    if (!this.program) return;
    // MapLibre v5 передає об'єкт замість масиву
    const mat = (matrix && matrix.defaultProjectionData)
      ? matrix.defaultProjectionData.mainMatrix : matrix;
    if (!mat) return;
    this.lastMatrix = mat;
    // зберегти стан GL
    const pBlend = gl.isEnabled(gl.BLEND);
    const pDepth = gl.isEnabled(gl.DEPTH_TEST);
    const pDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
    const pSrcRGB = gl.getParameter(gl.BLEND_SRC_RGB);
    const pDstRGB = gl.getParameter(gl.BLEND_DST_RGB);
    const pSrcA = gl.getParameter(gl.BLEND_SRC_ALPHA);
    const pDstA = gl.getParameter(gl.BLEND_DST_ALPHA);
    const pEqRGB = gl.getParameter(gl.BLEND_EQUATION_RGB);
    const pEqA = gl.getParameter(gl.BLEND_EQUATION_ALPHA);

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.uniform2f(this.u.viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.u.tex, 0);

    for (const sc of this.scenes.values()){
      if (!sc.visible || !sc.vao) continue;
      const mvp = mat4mul(mat, sc.model);
      const r0 = mvp[3], r1 = mvp[7], r2 = mvp[11];
      const L = sc.lastRow;
      const diff = Math.abs(r0-L[0]) + Math.abs(r1-L[1]) + Math.abs(r2-L[2]);
      const sum = Math.abs(r0) + Math.abs(r1) + Math.abs(r2);
      // поріг нижчий за референсний 1e-3: порядок сплатів щільніше тримається
      // за камерою, сцена не «пливе» при поворотах
      if (!(diff/sum <= 3e-4) && !sc.sorting){ // NaN у lastRow також запускає сортування
        sc.sorting = true;
        L[0]=r0; L[1]=r1; L[2]=r2;
        this.worker.postMessage({ type: "sort", id: sc.id, row: [r0, r1, r2] });
      }
      gl.uniformMatrix4fv(this.u.mvp, false, mvp);
      gl.uniform1i(this.u.cropOn, sc.crop.on ? 1 : 0);
      if (sc.crop.on){
        gl.uniformMatrix3fv(this.u.enu, false, sc.enu);
        gl.uniform4f(this.u.crop, sc.crop.rx, sc.crop.ry, sc.crop.hmin, sc.crop.hmax);
        gl.uniform1i(this.u.cropRect, sc.crop.shape === "rect" ? 1 : 0);
        const ra = (sc.crop.rot || 0) * Math.PI / 180;
        gl.uniform2f(this.u.cropRot, Math.cos(ra), Math.sin(ra));
      }
      gl.bindTexture(gl.TEXTURE_2D, sc.texture);
      gl.bindVertexArray(sc.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, sc.drawCount);
    }
    gl.bindVertexArray(null);

    // відновити стан GL
    if (pBlend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
    gl.blendFuncSeparate(pSrcRGB, pDstRGB, pSrcA, pDstA);
    gl.blendEquationSeparate(pEqRGB, pEqA);
    if (pDepth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(pDepthMask);
  }
}
