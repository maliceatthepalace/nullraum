// Local, encrypted persistence in IndexedDB. Every value is ciphertext;
// keys are only opaque room IDs and random message/media IDs.

let dbp;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('nullraum', 1);
    r.onupgradeneeded = () => {
      for (const s of ['vaults', 'msgs', 'media']) r.result.createObjectStore(s);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

const range = (roomId) => IDBKeyRange.bound(roomId + '|', roomId + '|￿');

export const store = {
  getVault: (roomId) => tx('vaults', 'readonly', (s) => s.get(roomId)),
  putVault: (roomId, v) => tx('vaults', 'readwrite', (s) => s.put(v, roomId)),
  vaultIds: () => tx('vaults', 'readonly', (s) => s.getAllKeys()),
  putMsg: (roomId, id, ct) => tx('msgs', 'readwrite', (s) => s.put(ct, roomId + '|' + id)),
  msgs: (roomId) => tx('msgs', 'readonly', (s) => s.getAll(range(roomId))),
  putMedia: (roomId, mid, ct) => tx('media', 'readwrite', (s) => s.put(ct, roomId + '|' + mid)),
  getMedia: (roomId, mid) => tx('media', 'readonly', (s) => s.get(roomId + '|' + mid)),
  hasMedia: (roomId, mid) => tx('media', 'readonly', (s) => s.count(roomId + '|' + mid)).then((n) => n > 0),

  async wipeRoom(roomId) {
    await tx('vaults', 'readwrite', (s) => s.delete(roomId));
    await tx('msgs', 'readwrite', (s) => s.delete(range(roomId)));
    await tx('media', 'readwrite', (s) => s.delete(range(roomId)));
  },

  async wipeAll() {
    for (const s of ['vaults', 'msgs', 'media']) await tx(s, 'readwrite', (o) => o.clear());
  },
};
