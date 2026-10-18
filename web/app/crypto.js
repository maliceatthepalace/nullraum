// RPC bridge to the WASM crypto worker plus small encoding helpers.

const worker = new Worker('crypto-worker.js');
let seq = 0;
const pending = new Map();

worker.onmessage = (e) => {
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  if (e.data.error) p.reject(new Error(e.data.error));
  else p.resolve(e.data.result);
};

function call(fn, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, fn, args });
  });
}

// C.seal(key, data, aad) etc. – see cmd/wasm/main.go for the full list.
export const C = new Proxy({}, { get: (_, fn) => (...a) => call(fn, ...a) });

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unb64(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function hex(u8) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const json = (v) => enc.encode(JSON.stringify(v));
export const parse = (u8) => JSON.parse(dec.decode(u8));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
