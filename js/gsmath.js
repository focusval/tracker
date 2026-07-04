// Чиста математика гаусових сплатів. Формули перевірені на реальних сценах
// Luma (додаток A специфікації) — не змінювати без вагомої причини.

const _fb = new Float32Array(1);
const _ib = new Uint32Array(_fb.buffer);

// Біти float32 як uint32 (для упаковки позицій у текстуру RGBA32UI).
export function f2u(v){ _fb[0]=v; return _ib[0]; }

// float32 → half float (16 біт).
export function toHalf(v){ _fb[0]=v; const x=_ib[0]; const sign=(x>>16)&0x8000;
  let exp=(x>>23)&0xff, man=x&0x7fffff;
  if(exp===255) return sign|0x7c00;
  exp=exp-127+15;
  if(exp>=31) return sign|0x7c00;
  if(exp<=0){ if(exp<-10) return sign; man=(man|0x800000)>>(1-exp); return sign|((man+0x1000)>>13); }
  // "+" замість "|": при округленні мантиса може переповнитись (напр. 8191.998),
  // і каррі мусить перенестись в експоненту, інакше значення вдвічі менше
  return sign+(exp<<10)+((man+0x1000)>>13); }

export function pack2h(a,b){ return (toHalf(a)|(toHalf(b)<<16))>>>0; }

// Множення 4×4 колонково-мажорних матриць; обчислення у подвійній точності,
// вихід Float32Array для uniform.
export function mat4mul(a,b){
  const o=new Float32Array(16);
  for(let c=0;c<4;c++){ const b0=b[c*4],b1=b[c*4+1],b2=b[c*4+2],b3=b[c*4+3];
    for(let r=0;r<4;r++) o[c*4+r]=a[r]*b0+a[4+r]*b1+a[8+r]*b2+a[12+r]*b3; }
  return o; }

// 3D-коваріація зі scale + кватерніона (w,x,y,z): Σ = M·Mᵀ, M = R·S.
// Записує 6 унікальних елементів (xx,xy,xz,yy,yz,zz) в out починаючи з o.
export function covFrom(sx,sy,sz,w,x,y,z,out,o){
  const m00=(1-2*(y*y+z*z))*sx, m01=(2*(x*y-w*z))*sy, m02=(2*(x*z+w*y))*sz;
  const m10=(2*(x*y+w*z))*sx, m11=(1-2*(x*x+z*z))*sy, m12=(2*(y*z-w*x))*sz;
  const m20=(2*(x*z-w*y))*sx, m21=(2*(y*z+w*x))*sy, m22=(1-2*(x*x+y*y))*sz;
  out[o]=m00*m00+m01*m01+m02*m02; out[o+1]=m00*m10+m01*m11+m02*m12;
  out[o+2]=m00*m20+m01*m21+m02*m22; out[o+3]=m10*m10+m11*m11+m12*m12;
  out[o+4]=m10*m20+m11*m21+m12*m22; out[o+5]=m20*m20+m21*m21+m22*m22; }

// Центрування по центроїду — один раз при імпорті нового файлу
// (позиції стають відносними до якоря сцени). НЕ викликати при завантаженні
// вже збережених .splat з репозиторію — вони вже центровані.
export function centerCloud(d){ let mx=0,my=0,mz=0,n=0;
  for(let i=0;i<d.count;i++){ const x=d.pos[i*3],y=d.pos[i*3+1],z=d.pos[i*3+2];
    if(Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(z)){ mx+=x;my+=y;mz+=z;n++; } }
  if(!n) return; mx/=n;my/=n;mz/=n;
  for(let i=0;i<d.count;i++){ d.pos[i*3]-=mx; d.pos[i*3+1]-=my; d.pos[i*3+2]-=mz; } }

// Пакування в текстуру RGBA32UI шириною 2048 (2 текселі на сплат).
export function buildTexData(d){
  const h=Math.max(1,Math.ceil(d.count/1024));
  const tex=new Uint32Array(2048*h*4);
  for(let i=0;i<d.count;i++){ const o=i*8,c=i*6;
    tex[o]=f2u(d.pos[i*3]); tex[o+1]=f2u(d.pos[i*3+1]); tex[o+2]=f2u(d.pos[i*3+2]);
    tex[o+3]=(d.col[i*4]|(d.col[i*4+1]<<8)|(d.col[i*4+2]<<16)|(d.col[i*4+3]<<24))>>>0;
    tex[o+4]=pack2h(d.cov[c],d.cov[c+1]); tex[o+5]=pack2h(d.cov[c+2],d.cov[c+3]);
    tex[o+6]=pack2h(d.cov[c+4],d.cov[c+5]); tex[o+7]=0; }
  return {tex,height:h}; }

// Матриця повороту R = Rz·Ry·Rx з кутів Ейлера у градусах.
// Рядково-мажорний масив [r00,r01,r02, r10,r11,r12, r20,r21,r22] —
// ті самі формули, що в модельній матриці рендерера.
export function rotationFromEuler(rxDeg, ryDeg, rzDeg){
  const D=Math.PI/180;
  const ca=Math.cos(rxDeg*D),sa=Math.sin(rxDeg*D);
  const cb=Math.cos(ryDeg*D),sb=Math.sin(ryDeg*D);
  const cc=Math.cos(rzDeg*D),s2=Math.sin(rzDeg*D);
  return [
    cc*cb, cc*sb*sa-s2*ca, cc*sb*ca+s2*sa,
    s2*cb, s2*sb*sa+cc*ca, s2*sb*ca-cc*sa,
    -sb,   cb*sa,          cb*ca,
  ];
}

// Перетворення «локальна позиція сплата → метри схід/північ/вгору відносно
// якоря сцени»: ENU = scale·R·p. Інверсія осі y меркатора і напрямок «північ»
// взаємно скорочуються, тому меркаторні одиниці тут не потрібні.
// Повертає рядково-мажорну 3×3.
export function enuMatrix(params){
  const R = rotationFromEuler(params.rx||0, params.ry||0, params.rz||0);
  const s = params.scale || 1;
  for (let i=0;i<9;i++) R[i]*=s;
  return R;
}

// Той самий тест обрізки, що у вершинному шейдері: еліпс по осях схід/північ
// (радіуси в метрах) + діапазон висот відносно якоря.
export function cropKeeps(crop, e, n, u){
  const qe=e/crop.rx, qn=n/crop.ry;
  if (qe*qe + qn*qn > 1) return false;
  if (u < crop.hmin || u > crop.hmax) return false;
  return true;
}

// Власний вектор найменшого власного числа симетричної 3×3 матриці
// (метод Якобі). m = [xx, xy, xz, yy, yz, zz].
export function smallestEigenvector3(m){
  const a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++){
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++){
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = theta === 0 ? 1 : Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++){
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++){
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++){
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const evs = [a[0][0], a[1][1], a[2][2]];
  let mi = 0;
  if (evs[1] < evs[mi]) mi = 1;
  if (evs[2] < evs[mi]) mi = 2;
  const n = [v[0][mi], v[1][mi], v[2][mi]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / len, n[1] / len, n[2] / len];
}

// Авто-рівень: за хмарою точок знаходить домінантну площину (землю),
// повертає кути rx/ry, що кладуть її горизонтально (rz не чіпає — це напрям
// на північ), і alt, що ставить землю на рівень карти.
// crop (той самий формат, що в шейдері) — необов'язковий фільтр: якщо заданий,
// аналізуються лише сплати всередині обрізки (сфера «неба» Luma не заважає).
// Повертає null, якщо точок замало.
export function estimateLevel(pos, count, params, crop){
  const M = crop ? enuMatrix(params) : null;
  const step = Math.max(1, Math.floor(count / 60000));
  const px = [], py = [], pz = [];
  for (let i = 0; i < count; i += step){
    const x = pos[i*3], y = pos[i*3+1], z = pos[i*3+2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (M){
      const e = M[0]*x + M[1]*y + M[2]*z;
      const nn = M[3]*x + M[4]*y + M[5]*z;
      const u = M[6]*x + M[7]*y + M[8]*z;
      if (!cropKeeps(crop, e, nn, u)) continue;
    }
    px.push(x); py.push(y); pz.push(z);
  }
  const n0 = px.length;
  if (n0 < 100) return null;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n0; i++){ cx += px[i]; cy += py[i]; cz += pz[i]; }
  cx /= n0; cy /= n0; cz /= n0;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n0; i++){
    const dx = px[i]-cx, dy = py[i]-cy, dz = pz[i]-cz;
    xx += dx*dx; xy += dx*dy; xz += dx*dz; yy += dy*dy; yz += dy*dz; zz += dz*dz;
  }
  let n = smallestEigenvector3([xx/n0, xy/n0, xz/n0, yy/n0, yz/n0, zz/n0]);
  // знак «вгору»: над землею більше маси (будівлі, дерева) — довший хвіст угору,
  // тож середнє проєкцій має бути більшим за медіану. Якщо виразного «верху»
  // немає (майже симетричний шум), не перевертаємо — тримаємось поточної
  // орієнтації сцени.
  const proj = new Float64Array(n0);
  for (let i = 0; i < n0; i++)
    proj[i] = n[0]*(px[i]-cx) + n[1]*(py[i]-cy) + n[2]*(pz[i]-cz);
  const sorted = Float64Array.from(proj).sort();
  const median = sorted[n0 >> 1];
  let mean = 0;
  for (let i = 0; i < n0; i++) mean += proj[i];
  mean /= n0;
  const spread = (sorted[Math.floor(n0 * 0.9)] - sorted[Math.floor(n0 * 0.1)]) || 1;
  const skew = mean - median;
  if (Math.abs(skew) > 0.02 * spread){
    if (skew < 0) n = [-n[0], -n[1], -n[2]];
  } else {
    const Rc = rotationFromEuler(params.rx || 0, params.ry || 0, params.rz || 0);
    if (n[0]*Rc[6] + n[1]*Rc[7] + n[2]*Rc[8] < 0) n = [-n[0], -n[1], -n[2]];
  }
  const DEG = 180 / Math.PI;
  const rx = Math.atan2(n[1], n[2]) * DEG;
  const ry = Math.atan2(-n[0], Math.hypot(n[1], n[2])) * DEG;
  // рівень землі — нижній перцентиль проєкцій відносно якоря сцени
  const abs = new Float64Array(n0);
  for (let i = 0; i < n0; i++) abs[i] = n[0]*px[i] + n[1]*py[i] + n[2]*pz[i];
  abs.sort();
  const ground = abs[Math.floor(n0 * 0.08)];
  let alt = -(params.scale || 1) * ground;
  if (alt < -80) alt = -80;
  if (alt > 200) alt = 200;
  return { rx, ry, alt };
}

// Індекси сплатів, що лишаються після обрізки (для запікання на CPU).
export function filterCrop(pos, count, params, crop){
  const M = enuMatrix(params);
  const keep = [];
  for (let i=0;i<count;i++){
    const x=pos[i*3], y=pos[i*3+1], z=pos[i*3+2];
    const e=M[0]*x+M[1]*y+M[2]*z;
    const n=M[3]*x+M[4]*y+M[5]*z;
    const u=M[6]*x+M[7]*y+M[8]*z;
    if (cropKeeps(crop, e, n, u)) keep.push(i);
  }
  return keep;
}
