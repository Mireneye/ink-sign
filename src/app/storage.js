// chrome.storage when running as an extension, localStorage when opened as a plain page during development.
const ext = typeof chrome !== "undefined" && chrome.storage;

async function get(area, key) {
  if (ext) return (await chrome.storage[area].get(key))[key];
  try { return JSON.parse(localStorage.getItem(`${area}:${key}`)); } catch { return undefined; }
}
async function set(area, key, value) {
  if (ext) return chrome.storage[area].set({ [key]: value });
  try { localStorage.setItem(`${area}:${key}`, JSON.stringify(value)); } catch {}
}

// Brush settings are small and follow the user across their browsers.
export const getBrush = () => get("sync", "brush");
export const setBrush = (v) => set("sync", "brush", v);
// The drawn signature can exceed sync's per-item quota, so it stays on this machine.
export const getSignature = () => get("local", "signature");
export const setSignature = (v) => set("local", "signature", v);

// The digital ID holds a non-extractable CryptoKey, which only IndexedDB can store.
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("ink-sign", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("identity");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction("identity", mode);
    const r = fn(t.objectStore("identity"));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}
export const getIdentity = () => tx("readonly", (s) => s.get("default"));
export const setIdentity = (v) => tx("readwrite", (s) => s.put(v, "default"));
export const deleteIdentity = () => tx("readwrite", (s) => s.delete("default"));
