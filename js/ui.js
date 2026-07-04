// Дрібні DOM-помічники: тости, прогрес, форматування чисел.

export const $ = (sel) => document.querySelector(sel);

const nfInt = new Intl.NumberFormat("uk-UA");
export const fmtInt = (n) => nfInt.format(Math.round(n));
export const fmtMB = (bytes) => (bytes / 1048576).toFixed(1) + " МБ";
export const fmtPct = (f) => Math.round(f * 100) + "%";

let toastTimer = null;
export function toast(msg, kind = "info", ms = 5000){
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast " + kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function toastError(err){
  console.error(err);
  toast(err && err.message ? err.message : String(err), "error", 9000);
}

export function showProgress(text, frac){
  const box = $("#progress");
  box.hidden = false;
  $("#progressText").textContent = text;
  const bar = $("#progressBar");
  if (frac == null){ bar.style.width = "100%"; bar.classList.add("pulse"); }
  else { bar.classList.remove("pulse"); bar.style.width = Math.round(frac * 100) + "%"; }
}

export function hideProgress(){
  $("#progress").hidden = true;
}

// Завантаження з прогресом читання відповіді.
export async function fetchWithProgress(url, onFrac){
  const res = await fetch(url);
  if (!res.ok) throw new Error("Не вдалося завантажити " + url + " (HTTP " + res.status + ")");
  const total = +res.headers.get("Content-Length") || 0;
  if (!res.body || !total){
    const buf = await res.arrayBuffer();
    if (onFrac) onFrac(1);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;){
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (onFrac) onFrac(Math.min(1, got / total));
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks){ out.set(c, o); o += c.length; }
  return out.buffer;
}

export function downloadText(filename, text){
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
}
