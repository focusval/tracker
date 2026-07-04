// Робота з GitHub REST API прямо з браузера (без бекенда).
// Файли ≤40 МБ — Contents API; більші — Git Data API (blob → tree → commit).

const API = "https://api.github.com";
export const CONTENTS_LIMIT = 40 * 1024 * 1024;
export const HARD_LIMIT = 95 * 1024 * 1024;

export function humanError(status, detail){
  if (status === 401) return "Токен недійсний або прострочений. Введи новий токен у режимі редагування.";
  if (status === 403) return "Немає прав (перевір, що токен має Contents: Read and write саме для цього репозиторію) або вичерпано ліміт запитів GitHub — зачекай кілька хвилин.";
  if (status === 404) return "Немає прав або файл/репозиторій не знайдено. Перевір права токена (Contents: Read and write).";
  if (status === 409 || status === 422) return "Конфлікт версій: файл уже змінено деінде. Онови сторінку і повтори.";
  if (status === 0) return "Немає з'єднання з GitHub. Перевір інтернет і спробуй ще раз.";
  return "GitHub API: помилка " + status + (detail ? " — " + detail : "");
}

export class GitHubError extends Error {
  constructor(status, detail){
    super(humanError(status, detail));
    this.status = status;
  }
}

// ArrayBuffer/Uint8Array → base64 частинами (щоб не тримати гігантський
// проміжний рядок цілком і не впертись у ліміт аргументів fromCharCode).
export function toBase64(bytes){
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CH = 0x8000 * 3; // кратно 3 — base64-частини конкатенуються без паддінгу
  const parts = [];
  for (let i = 0; i < u8.length; i += CH){
    const sub = u8.subarray(i, Math.min(i + CH, u8.length));
    let bin = "";
    for (let j = 0; j < sub.length; j += 0x8000)
      bin += String.fromCharCode.apply(null, sub.subarray(j, j + 0x8000));
    parts.push(btoa(bin));
  }
  return parts.join("");
}

export class GitHubClient {
  constructor({ owner, repo, branch, token }){
    this.owner = owner; this.repo = repo;
    this.branch = branch || "main";
    this.token = token;
  }

  _headers(){
    return {
      "Authorization": "Bearer " + this.token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  async _json(method, path, body){
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: { ...this._headers(), ...(body ? {"Content-Type": "application/json"} : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError(0);
    }
    if (!res.ok){
      let detail = "";
      try { detail = (await res.json()).message || ""; } catch {}
      throw new GitHubError(res.status, detail);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  _repoPath(p){ return `/repos/${this.owner}/${this.repo}/${p}`; }

  async checkAccess(){
    const me = await this._json("GET", "/user");
    await this._json("GET", this._repoPath(""));
    return me.login;
  }

  // sha файлу в гілці або null, якщо файлу нема.
  async getFileSha(path){
    try {
      const j = await this._json("GET", this._repoPath(`contents/${path}?ref=${this.branch}`));
      return j.sha || null;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  // Сирі байти файлу через API (працює і до редеплою Pages, до 100 МБ).
  async getRawFile(path, onProgress){
    let res;
    try {
      res = await fetch(API + this._repoPath(`contents/${path}?ref=${this.branch}`), {
        headers: { ...this._headers(), "Accept": "application/vnd.github.raw+json" },
      });
    } catch {
      throw new GitHubError(0);
    }
    if (!res.ok) throw new GitHubError(res.status);
    const total = +res.headers.get("Content-Length") || 0;
    if (!res.body || !total){
      const buf = await res.arrayBuffer();
      if (onProgress) onProgress(1);
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = []; let got = 0;
    for (;;){
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      if (onProgress) onProgress(Math.min(1, got / total));
    }
    const out = new Uint8Array(got); let o = 0;
    for (const c of chunks){ out.set(c, o); o += c.length; }
    return out.buffer;
  }

  // XHR замість fetch — заради прогресу відвантаження на великих файлах.
  _xhrJson(method, path, bodyObj, onProgress){
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, API + path);
      const h = this._headers();
      for (const k in h) xhr.setRequestHeader(k, h[k]);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.responseType = "json";
      if (onProgress && xhr.upload)
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onerror = () => reject(new GitHubError(0));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
        else reject(new GitHubError(xhr.status, xhr.response && xhr.response.message));
      };
      xhr.send(JSON.stringify(bodyObj));
    });
  }

  // Коміт файлу ≤40 МБ через Contents API. content — ArrayBuffer/Uint8Array або рядок.
  async putFileSmall(path, content, message, onProgress){
    const b64 = typeof content === "string"
      ? toBase64(new TextEncoder().encode(content))
      : toBase64(content);
    const sha = await this.getFileSha(path);
    const body = { message, content: b64, branch: this.branch };
    if (sha) body.sha = sha;
    return this._xhrJson("PUT", this._repoPath(`contents/${path}`), body, onProgress);
  }

  // Коміт великого файлу через Git Data API: blob → tree → commit → ref.
  async putFileLarge(path, content, message, onProgress){
    const b64 = toBase64(content);
    // найдовша фаза — відвантаження blob: відводимо їй 0..0.9 прогресу
    const blob = await this._xhrJson("POST", this._repoPath("git/blobs"),
      { content: b64, encoding: "base64" },
      onProgress ? (f) => onProgress(f * 0.9) : null);
    if (onProgress) onProgress(0.92);
    const ref = await this._json("GET", this._repoPath(`git/ref/heads/${this.branch}`));
    const headSha = ref.object.sha;
    const headCommit = await this._json("GET", this._repoPath(`git/commits/${headSha}`));
    if (onProgress) onProgress(0.95);
    const tree = await this._json("POST", this._repoPath("git/trees"), {
      base_tree: headCommit.tree.sha,
      tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }],
    });
    const commit = await this._json("POST", this._repoPath("git/commits"), {
      message, tree: tree.sha, parents: [headSha],
    });
    await this._json("PATCH", this._repoPath(`git/refs/heads/${this.branch}`), { sha: commit.sha });
    if (onProgress) onProgress(1);
    return commit;
  }

  // Універсальний коміт бінарного файлу: сам обирає API за розміром.
  async putFile(path, bytes, message, onProgress){
    const size = bytes.byteLength;
    if (size > HARD_LIMIT)
      throw new Error("Файл завеликий для GitHub (" + (size/1048576).toFixed(1) +
        " МБ, ліміт 95 МБ). Зменш кількість сплатів у SuperSplat і спробуй ще раз.");
    if (size <= CONTENTS_LIMIT) return this.putFileSmall(path, bytes, message, onProgress);
    return this.putFileLarge(path, bytes, message, onProgress);
  }

  async deleteFile(path, message){
    const sha = await this.getFileSha(path);
    if (!sha) return null;
    return this._json("DELETE", this._repoPath(`contents/${path}`),
      { message, sha, branch: this.branch });
  }
}
