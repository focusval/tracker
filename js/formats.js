// Парсери .splat / .ply та запис .splat. Обидва парсери повертають
// { count, pos:F32(3n), cov:F32(6n), col:U8(4n), scl:F32(3n), rot:F32(4n) } —
// сирі атрибути потрібні для запікання обрізки назад у .splat.

import { covFrom } from "./gsmath.js";

export const SPLAT_BYTES = 32;

// .splat (формат antimatter15, 32 байти/сплат):
// позиція f32×3, scale f32×3, колір RGBA u8×4,
// кватерніон u8×4 як q*128+128 (порядок w,x,y,z).
export function parseSplatFile(buffer){
  const n=Math.floor(buffer.byteLength/32);
  if (buffer.byteLength % 4 !== 0) buffer = buffer.slice(0, n*32);
  const f=new Float32Array(buffer), u=new Uint8Array(buffer);
  const pos=new Float32Array(n*3), cov=new Float32Array(n*6), col=new Uint8Array(n*4);
  const scl=new Float32Array(n*3), rot=new Float32Array(n*4);
  for(let i=0;i<n;i++){
    pos[i*3]=f[i*8]; pos[i*3+1]=f[i*8+1]; pos[i*3+2]=f[i*8+2];
    scl[i*3]=f[i*8+3]; scl[i*3+1]=f[i*8+4]; scl[i*3+2]=f[i*8+5];
    col[i*4]=u[i*32+24]; col[i*4+1]=u[i*32+25]; col[i*4+2]=u[i*32+26]; col[i*4+3]=u[i*32+27];
    let qw=(u[i*32+28]-128)/128, qx=(u[i*32+29]-128)/128, qy=(u[i*32+30]-128)/128, qz=(u[i*32+31]-128)/128;
    const qn=Math.hypot(qw,qx,qy,qz)||1;
    rot[i*4]=qw/qn; rot[i*4+1]=qx/qn; rot[i*4+2]=qy/qn; rot[i*4+3]=qz/qn;
    covFrom(scl[i*3],scl[i*3+1],scl[i*3+2],rot[i*4],rot[i*4+1],rot[i*4+2],rot[i*4+3],cov,i*6); }
  return {count:n,pos,cov,col,scl,rot}; }

export const PLY_SIZES={float:4,float32:4,double:8,float64:8,int:4,int32:4,uint:4,uint32:4,
  short:2,int16:2,ushort:2,uint16:2,char:1,int8:1,uchar:1,uint8:1};

// .ply (binary_little_endian; gaussian: x,y,z, f_dc_0..2, opacity, scale_0..2 (log),
// rot_0..3 (w,x,y,z); fallback без scale_0 — хмара точок з red/green/blue).
export function parsePlyFile(buffer){
  const head=new Uint8Array(buffer,0,Math.min(buffer.byteLength,65536));
  const headText=new TextDecoder("ascii").decode(head);
  const endTag="end_header\n"; const endIdx=headText.indexOf(endTag);
  if(endIdx<0||!headText.startsWith("ply")) throw new Error("Це не PLY-файл");
  if(!headText.includes("binary_little_endian"))
    throw new Error("Підтримується лише binary_little_endian PLY (у SuperSplat експортуй uncompressed PLY)");
  const dataStart=endIdx+endTag.length;
  let count=0; const props=[]; let inVertex=false;
  for(const line of headText.slice(0,endIdx).split("\n")){
    const p=line.trim().split(/\s+/);
    if(p[0]==="element"){ inVertex=(p[1]==="vertex"); if(inVertex) count=parseInt(p[2]); }
    else if(p[0]==="property"&&inVertex){
      if(p[1]==="list") throw new Error("PLY зі списками не підтримується");
      props.push({name:p[2],type:p[1]}); } }
  let stride=0; const off={}, typ={};
  for(const pr of props){ off[pr.name]=stride; typ[pr.name]=pr.type; stride+=PLY_SIZES[pr.type]||4; }
  const dv=new DataView(buffer,dataStart);
  const rd=(name,base)=>{ const t=typ[name], o=base+off[name];
    if(t==="float"||t==="float32") return dv.getFloat32(o,true);
    if(t==="double"||t==="float64") return dv.getFloat64(o,true);
    if(t==="uchar"||t==="uint8") return dv.getUint8(o);
    if(t==="char"||t==="int8") return dv.getInt8(o);
    if(t==="ushort"||t==="uint16") return dv.getUint16(o,true);
    if(t==="short"||t==="int16") return dv.getInt16(o,true);
    if(t==="uint"||t==="uint32") return dv.getUint32(o,true);
    return dv.getInt32(o,true); };
  const gaussian=("scale_0" in off)&&("rot_0" in off);
  const pos=new Float32Array(count*3), cov=new Float32Array(count*6), col=new Uint8Array(count*4);
  const scl=new Float32Array(count*3), rot=new Float32Array(count*4);
  const SH=0.28209479177387814; const c255=(v)=>Math.max(0,Math.min(255,v))|0;
  for(let i=0;i<count;i++){ const b=i*stride;
    pos[i*3]=rd("x",b); pos[i*3+1]=rd("y",b); pos[i*3+2]=rd("z",b);
    if(gaussian){
      scl[i*3]=Math.exp(rd("scale_0",b)); scl[i*3+1]=Math.exp(rd("scale_1",b)); scl[i*3+2]=Math.exp(rd("scale_2",b));
      let qw=rd("rot_0",b),qx=rd("rot_1",b),qy=rd("rot_2",b),qz=rd("rot_3",b);
      const qn=Math.hypot(qw,qx,qy,qz)||1;
      rot[i*4]=qw/qn; rot[i*4+1]=qx/qn; rot[i*4+2]=qy/qn; rot[i*4+3]=qz/qn;
      covFrom(scl[i*3],scl[i*3+1],scl[i*3+2],rot[i*4],rot[i*4+1],rot[i*4+2],rot[i*4+3],cov,i*6);
      col[i*4]=c255((0.5+SH*rd("f_dc_0",b))*255); col[i*4+1]=c255((0.5+SH*rd("f_dc_1",b))*255);
      col[i*4+2]=c255((0.5+SH*rd("f_dc_2",b))*255); col[i*4+3]=c255(255/(1+Math.exp(-rd("opacity",b))));
    } else { const s=0.03;
      scl[i*3]=s; scl[i*3+1]=s; scl[i*3+2]=s; rot[i*4]=1;
      cov[i*6]=s*s; cov[i*6+3]=s*s; cov[i*6+5]=s*s;
      col[i*4]=("red" in off)?rd("red",b):200; col[i*4+1]=("green" in off)?rd("green",b):200;
      col[i*4+2]=("blue" in off)?rd("blue",b):200; col[i*4+3]=255; } }
  return {count,pos,cov,col,scl,rot}; }

// Запис у .splat. keep — необов'язковий масив індексів сплатів, які лишаються
// (для запікання обрізки); без нього пишуться всі.
export function writeSplat(d, keep){
  const n = keep ? keep.length : d.count;
  const buf = new ArrayBuffer(n*32);
  const f = new Float32Array(buf), u = new Uint8Array(buf);
  const q255 = v => Math.max(0, Math.min(255, Math.round(v*128+128)));
  for(let j=0;j<n;j++){
    const i = keep ? keep[j] : j;
    f[j*8]=d.pos[i*3]; f[j*8+1]=d.pos[i*3+1]; f[j*8+2]=d.pos[i*3+2];
    f[j*8+3]=d.scl[i*3]; f[j*8+4]=d.scl[i*3+1]; f[j*8+5]=d.scl[i*3+2];
    u[j*32+24]=d.col[i*4]; u[j*32+25]=d.col[i*4+1]; u[j*32+26]=d.col[i*4+2]; u[j*32+27]=d.col[i*4+3];
    u[j*32+28]=q255(d.rot[i*4]); u[j*32+29]=q255(d.rot[i*4+1]);
    u[j*32+30]=q255(d.rot[i*4+2]); u[j*32+31]=q255(d.rot[i*4+3]);
  }
  return buf;
}
