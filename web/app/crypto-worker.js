// Runs the Go/WASM crypto core off the main thread.
importScripts('wasm_exec.js');

const ready = (async () => {
  const go = new Go();
  const res = await WebAssembly.instantiateStreaming(fetch('nullraum.wasm'), go.importObject);
  go.run(res.instance);
})();

self.onmessage = async (ev) => {
  const { id, fn, args } = ev.data;
  try {
    await ready;
    const f = self.NullraumCrypto[fn];
    if (!f) throw new Error('unknown function ' + fn);
    const out = f(...args);
    if (out && typeof out === 'object' && !(out instanceof Uint8Array) && out.error) {
      self.postMessage({ id, error: out.error });
    } else {
      self.postMessage({ id, result: out });
    }
  } catch (e) {
    self.postMessage({ id, error: String(e && e.message || e) });
  }
};
