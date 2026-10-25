// Nullraum room protocol. See docs/PROTOCOL.md for the full description.
//
// Wire packets inside the relay's opaque "d" field: {k, e?, c}
//   k = 'j'  AEAD(joinKey)                     – hello, challenge, deny, rekey
//   k = 'q'  AEAD(joinKey ⊕ secret)            – join request
//   k = 'w'  HPKE(ML-KEM-768+X25519) ∘ AEAD(joinKey ⊕ secret) – welcome
//   k = 'r'  AEAD(roomKey[e])                  – everything inside the room

import { C, b64, unb64, hex, concat, json, parse, enc, sleep } from './crypto.js';
import { store } from './store.js';

const CHUNK = 192 * 1024;
export const MAX_MEDIA = 50 * 1024 * 1024;
const SYNC_LIMIT = 300;

const ctx = (what, roomId) => `nullraum/v1/${what}|${roomId}`;

export async function deriveRoom(code) {
  const master = await C.deriveMaster(code);
  return {
    code,
    master,
    roomId: hex(await C.hkdf(master, 'room-id', 32)),
    joinKey: await C.hkdf(master, 'join', 32),
    hdrKey: await C.hkdf(master, 'vault-header', 32),
  };
}

// The secret behind the optional extra protection, hardened with Argon2id.
export async function deriveSecret(protection, input) {
  if (!protection || protection.type === 'none') return null;
  let s;
  if (protection.type === 'password') s = input;
  else if (protection.type === 'key') s = await C.normalizeSecondKey(input);
  else if (protection.type === 'questions') {
    const norm = [];
    for (const a of input) norm.push(await C.normalizeAnswer(a));
    s = norm.join('\u001f');
  }
  return C.deriveSecret(s, unb64(protection.salt));
}

export async function readHeader(d) {
  const v = await store.getVault(d.roomId);
  if (!v) return null;
  return parse(await C.open(d.hdrKey, v.h, enc.encode('hdr|' + d.roomId)));
}

const memberIdOf = async (sigPub) => hex(await C.sha256(sigPub)).slice(0, 16);

export class Room extends EventTarget {
  constructor(d) {
    super();
    Object.assign(this, d); // code, master, roomId, joinKey, hdrKey
    this.state = 'idle';
    this.peers = new Set();
    this.messages = new Map();
    this.media = new Map(); // mid -> {n, parts, got}
    this.mediaWaiting = new Set();
    this.pendingRequests = new Map(); // peer -> request (admin)
    this.challenges = new Map(); // peer -> anonce (admin)
    this.failures = new Map(); // peer -> count (admin)
    this.heldPackets = new Map(); // epoch -> packets waiting for a key
    this.orphans = []; // envelopes from members not yet in the roster
    this.keys = {};
    this.epoch = 0;
    this.roster = null;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(s, info) { this.state = s; this.emit('state', { state: s, ...info }); }

  // ---------- creation / loading ----------

  static async create({ code, roomName, myName, protection, secretInput, history }) {
    const d = await deriveRoom(code);
    const r = new Room(d);
    r.protection = protection;
    r.secretKey = await deriveSecret(protection, secretInput);
    await r.makeIdentity(myName);
    r.admin = true;
    r.adminSig = r.me.sigPub;
    r.roomName = roomName;
    r.history = history;
    r.epoch = 1;
    r.keys = { 1: await C.random(32) };
    r.vaultKey = await r.deriveVaultKey();
    await r.setRoster({ version: 1, roomName, history, members: { [r.me.id]: r.memberEntry(myName, true, 0) } });
    await r.save();
    return r;
  }

  async makeIdentity(name) {
    const kem = await C.kemGenerate();
    const sig = await C.sigGenerate();
    this.me = { name, kemPriv: kem.priv, kemPub: kem.pub, sigPriv: sig.priv, sigPub: sig.pub, id: await memberIdOf(sig.pub) };
  }

  memberEntry(name, admin, since) {
    return { name, kem: b64(this.me.kemPub), sig: b64(this.me.sigPub), admin, since };
  }

  async deriveVaultKey() {
    return C.hkdf(concat(this.master, this.secretKey || new Uint8Array()), 'vault', 32);
  }

  async joinReqKey() {
    return C.hkdf(concat(this.joinKey, this.secretKey || new Uint8Array()), 'join-request', 32);
  }

  // Unlocks a room stored on this device. Throws on a wrong secret.
  static async unlock(d, header, secretInput) {
    const r = new Room(d);
    r.protection = header.protection;
    r.secretKey = await deriveSecret(header.protection, secretInput);
    r.vaultKey = await r.deriveVaultKey();
    const v = await store.getVault(d.roomId);
    let body;
    try {
      body = parse(await C.open(r.vaultKey, v.b, enc.encode('vault|' + d.roomId)));
    } catch {
      throw new Error('Falsches Passwort, falscher Schlüssel oder falsche Antworten.');
    }
    r.me = {
      name: body.me.name, id: body.me.id,
      kemPriv: unb64(body.me.kemPriv), kemPub: unb64(body.me.kemPub),
      sigPriv: unb64(body.me.sigPriv), sigPub: unb64(body.me.sigPub),
    };
    r.admin = body.admin;
    r.adminSig = unb64(body.adminSig);
    r.roomName = body.roomName;
    r.history = body.history;
    r.epoch = body.epoch;
    for (const [e, k] of Object.entries(body.keys)) r.keys[e] = unb64(k);
    r.rosterSigned = body.roster;
    r.roster = parse(unb64(body.roster.body));
    r.lastRekey = body.lastRekey || null;

    for (const ct of await store.msgs(d.roomId)) {
      try {
        const m = parse(await C.open(r.vaultKey, ct, enc.encode('msg|' + d.roomId)));
        r.messages.set(m.env.id, { env: m.env, envB64: m.envB64, sigB64: m.sigB64 });
      } catch { /* skip corrupt record */ }
    }
    return r;
  }

  async save() {
    const header = { v: 1, protection: this.protection };
    const body = {
      me: {
        name: this.me.name, id: this.me.id,
        kemPriv: b64(this.me.kemPriv), kemPub: b64(this.me.kemPub),
        sigPriv: b64(this.me.sigPriv), sigPub: b64(this.me.sigPub),
      },
      admin: this.admin, adminSig: b64(this.adminSig), roomName: this.roomName, history: this.history,
      epoch: this.epoch, keys: Object.fromEntries(Object.entries(this.keys).map(([e, k]) => [e, b64(k)])),
      roster: this.rosterSigned, lastRekey: this.lastRekey,
    };
    await store.putVault(this.roomId, {
      h: await C.seal(this.hdrKey, json(header), enc.encode('hdr|' + this.roomId)),
      b: await C.seal(this.vaultKey, json(body), enc.encode('vault|' + this.roomId)),
    });
  }

  // ---------- transport ----------

  connect() {
    this.closed = false;
    this.backoff ??= 1000;
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'join', room: this.roomId })); this.backoff = 1000; };
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      // Frames are handled strictly in order; key changes depend on it.
      this.queue = (this.queue || Promise.resolve()).then(() => this.onFrame(f)).catch((e) => console.warn('frame', e));
    };
    ws.onclose = () => {
      this.peers.clear();
      this.emit('peers');
      if (this.closed) return;
      this.emit('connection', { online: false });
      setTimeout(() => !this.closed && this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    };
  }

  disconnect() {
    this.closed = true;
    clearInterval(this.helloTimer);
    this.ws?.close();
  }

  send(packet, { to, store: keep } = {}) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ t: 'send', to, store: !!keep, d: packet }));
    return true;
  }

  async seal(layer, obj, epoch) {
    if (layer === 'j') return { k: 'j', c: b64(await C.seal(this.joinKey, json(obj), enc.encode('j|' + this.roomId))) };
    if (layer === 'q') return { k: 'q', c: b64(await C.seal(await this.joinReqKey(), json(obj), enc.encode('q|' + this.roomId))) };
    const e = epoch ?? this.epoch;
    return { k: 'r', e, c: b64(await C.seal(this.keys[e], json(obj), enc.encode(`r|${this.roomId}|${e}`))) };
  }

  async sendRoom(obj, opts) { return this.send(await this.seal('r', obj), opts); }

  async onFrame(f) {
    switch (f.t) {
      case 'hello':
        this.myPeer = f.peer;
        for (const p of f.peers || []) this.peers.add(p);
        this.emit('peers');
        this.emit('connection', { online: true });
        return;
      case 'mailbox_end':
        if (this.state === 'member') this.requestSync();
        else if (this.state === 'joining') this.startHello();
        return;
      case 'peer_join':
        this.peers.add(f.peer);
        this.emit('peers');
        if (this.state === 'joining' && !this.adminPeer) this.sendHello();
        return;
      case 'peer_leave':
        this.peers.delete(f.peer);
        this.pendingRequests.delete(f.peer);
        this.emit('peers');
        this.emit('requests');
        return;
      case 'recv':
        return this.onPacket(f.d, f.from || null);
    }
  }

  async onPacket(d, from) {
    if (!d || typeof d.c !== 'string') return;
    const ct = unb64(d.c);
    if (d.k === 'j') {
      let p;
      try { p = parse(await C.open(this.joinKey, ct, enc.encode('j|' + this.roomId))); } catch { return; }
      return this.onJoinLayer(p, from);
    }
    if (d.k === 'q') return this.admin && this.onJoinRequest(ct, from);
    if (d.k === 'w') return this.onWelcome(ct);
    if (d.k === 'r') {
      const key = this.keys[d.e];
      if (!key) {
        if (!this.heldPackets.has(d.e)) this.heldPackets.set(d.e, []);
        this.heldPackets.get(d.e).push([d, from]);
        return;
      }
      let p;
      try { p = parse(await C.open(key, ct, enc.encode(`r|${this.roomId}|${d.e}`))); } catch { return; }
      return this.onRoomPacket(p, from);
    }
  }

  // ---------- joining (joiner side) ----------

  static async startJoin(d, myName) {
    const r = new Room(d);
    r.me = { name: myName };
    r.nonce = b64(await C.random(16));
    r.setState('joining');
    r.connect();
    return r;
  }

  startHello() {
    this.sendHello();
    clearInterval(this.helloTimer);
    this.helloTimer = setInterval(() => this.state === 'joining' && this.sendHello(), 8000);
  }

  async sendHello() {
    this.send(await this.seal('j', { type: 'hello', nonce: this.nonce }));
  }

  async onJoinLayer(p, from) {
    if (p.type === 'hello' && this.admin && this.state === 'member') return this.onHello(p, from);
    if (p.type === 'rekey') return this.onRekey(p);
    if (from !== null && from === this.adminPeer && p.type === 'deny') {
      if (p.reason === 'secret') {
        this.secretKey = null;
        this.setState('need-secret', { protection: this.protection, error: 'Das war leider falsch.' });
      } else {
        this.disconnect();
        this.setState('denied');
      }
      return;
    }
    if (p.type === 'challenge' && this.state === 'joining') return this.onChallenge(p, from);
  }

  async onChallenge(p, from) {
    const body = parse(unb64(p.body));
    const adminSig = unb64(body.adminSig);
    if (body.nonce !== this.nonce) return;
    if (!(await C.verify(adminSig, unb64(p.body), unb64(p.sig), ctx('challenge', this.roomId)))) return;
    if (this.adminSig && b64(this.adminSig) !== body.adminSig) {
      // Two different "initiators" answered: someone else with the code is
      // trying to impersonate the real one.
      this.disconnect();
      this.setState('conflict');
      return;
    }
    this.adminSig = adminSig;
    this.adminPeer = from;
    this.anonce = body.anonce;
    this.protection = body.protection;
    clearInterval(this.helloTimer);
    if (!this.me.kemPriv) await this.makeIdentity(this.me.name);
    this.fingerprint = await C.fingerprint(this.adminSig, this.me.sigPub, this.me.kemPub);
    if (this.protection.type === 'none') return this.sendJoinRequest();
    this.setState('need-secret', { protection: this.protection });
  }

  async submitSecret(input) {
    this.secretKey = await deriveSecret(this.protection, input);
    await this.sendJoinRequest();
  }

  async sendJoinRequest() {
    const req = { type: 'joinreq', name: this.me.name, kem: b64(this.me.kemPub), sig: b64(this.me.sigPub), anonce: this.anonce };
    this.send(await this.seal('q', req), { to: this.adminPeer });
    this.setState('waiting', { fingerprint: this.fingerprint });
  }

  async onWelcome(ct) {
    if (this.state !== 'waiting') return;
    let w;
    try {
      const inner = await C.kemOpen(this.me.kemPriv, ctx('welcome', this.roomId), ct);
      w = parse(await C.open(await this.joinReqKey(), inner, enc.encode('w|' + this.roomId)));
    } catch { return; }
    const ok = await C.verify(this.adminSig, unb64(w.roster.body), unb64(w.roster.sig), ctx('roster', this.roomId));
    const roster = parse(unb64(w.roster.body));
    if (!ok || !roster.members[this.me.id]) return;
    this.admin = false;
    this.roomName = roster.roomName;
    this.history = roster.history;
    this.rosterSigned = w.roster;
    this.roster = roster;
    for (const [e, k] of Object.entries(w.keys)) this.keys[e] = unb64(k);
    this.epoch = w.epoch;
    this.vaultKey = await this.deriveVaultKey();
    await this.save();
    this.setState('member');
    this.requestSync();
  }

  // ---------- joining (initiator side) ----------

  async onHello(p, from) {
    if (!from || (this.failures.get(from) || 0) >= 3) return;
    const anonce = b64(await C.random(16));
    this.challenges.set(from, anonce);
    const body = json({ nonce: p.nonce, anonce, adminSig: b64(this.me.sigPub), protection: this.protection });
    const sig = await C.sign(this.me.sigPriv, body, ctx('challenge', this.roomId));
    this.send(await this.seal('j', { type: 'challenge', body: b64(body), sig: b64(sig) }), { to: from });
  }

  async onJoinRequest(ct, from) {
    if (!from || !this.challenges.has(from) || (this.failures.get(from) || 0) >= 3) return;
    let req;
    try {
      req = parse(await C.open(await this.joinReqKey(), ct, enc.encode('q|' + this.roomId)));
    } catch {
      const n = (this.failures.get(from) || 0) + 1;
      this.failures.set(from, n);
      this.emit('failed-attempt', { count: n });
      this.send(await this.seal('j', { type: 'deny', reason: 'secret' }), { to: from });
      return;
    }
    if (req.type !== 'joinreq' || req.anonce !== this.challenges.get(from)) return;
    const sigPub = unb64(req.sig);
    const kemPub = unb64(req.kem);
    const id = await memberIdOf(sigPub);
    const m = this.roster.members[id];
    if (m && !m.removed) return;
    const name = String(req.name || '').slice(0, 40) || 'Unbekannt';
    this.pendingRequests.set(from, { peer: from, id, name, sigPub, kemPub, fingerprint: await C.fingerprint(this.me.sigPub, sigPub, kemPub) });
    this.emit('requests');
  }

  async approve(peer) {
    const r = this.pendingRequests.get(peer);
    if (!r) return;
    this.pendingRequests.delete(peer);
    this.emit('requests');
    if (!this.history) await this.rotateKey(); // new members cannot read older messages
    const members = { ...this.roster.members, [r.id]: { name: r.name, kem: b64(r.kemPub), sig: b64(r.sigPub), admin: false, since: this.history ? 0 : Date.now() } };
    await this.setRoster({ ...this.roster, version: this.roster.version + 1, members });
    const keys = this.history
      ? Object.fromEntries(Object.entries(this.keys).map(([e, k]) => [e, b64(k)]))
      : { [this.epoch]: b64(this.keys[this.epoch]) };
    const w = { keys, epoch: this.epoch, roster: this.rosterSigned };
    const inner = await C.seal(await this.joinReqKey(), json(w), enc.encode('w|' + this.roomId));
    const outer = await C.kemSeal(r.kemPub, ctx('welcome', this.roomId), inner);
    this.send({ k: 'w', c: b64(outer) }, { to: peer });
    await this.broadcastRoster();
    await this.save();
  }

  async deny(peer) {
    this.pendingRequests.delete(peer);
    this.emit('requests');
    this.send(await this.seal('j', { type: 'deny', reason: 'admin' }), { to: peer });
  }

  // ---------- roster & keys ----------

  async setRoster(roster) {
    const body = json(roster);
    const sig = await C.sign(this.me.sigPriv, body, ctx('roster', this.roomId));
    this.rosterSigned = { body: b64(body), sig: b64(sig) };
    this.roster = roster;
    this.emit('roster');
  }

  async broadcastRoster(to) {
    await this.sendRoom({ type: 'roster', ...this.rosterSigned }, { store: !to, to });
  }

  async onRoster(p) {
    if (!(await C.verify(this.adminSig, unb64(p.body), unb64(p.sig), ctx('roster', this.roomId)))) return;
    const roster = parse(unb64(p.body));
    if (this.roster && roster.version <= this.roster.version) return;
    this.roster = roster;
    this.rosterSigned = { body: p.body, sig: p.sig };
    this.roomName = roster.roomName;
    const mine = roster.members[this.me.id];
    if (!mine || mine.removed) return this.destroy('removed');
    await this.save();
    this.emit('roster');
    const orphans = this.orphans;
    this.orphans = [];
    for (const o of orphans) await this.acceptEnvelope(o.envB64, o.sigB64);
  }

  // New epoch key, sealed with ML-KEM-768+X25519 to every remaining member.
  async rotateKey() {
    const epoch = this.epoch + 1;
    const key = await C.random(32);
    const sealed = {};
    for (const [id, m] of Object.entries(this.roster.members)) {
      if (m.removed || id === this.me.id) continue;
      sealed[id] = b64(await C.kemSeal(unb64(m.kem), ctx('rekey', this.roomId) + '|' + epoch, key));
    }
    const body = json({ epoch, sealed });
    const sig = await C.sign(this.me.sigPriv, body, ctx('rekey', this.roomId));
    this.lastRekey = { type: 'rekey', body: b64(body), sig: b64(sig) };
    this.keys[epoch] = key;
    this.epoch = epoch;
    this.send(await this.seal('j', this.lastRekey), { store: true });
    await this.save();
    this.emit('epoch');
  }

  async onRekey(p) {
    if (!this.adminSig || !this.me?.kemPriv || !this.vaultKey) return;
    if (!(await C.verify(this.adminSig, unb64(p.body), unb64(p.sig), ctx('rekey', this.roomId)))) return;
    const body = parse(unb64(p.body));
    if (this.keys[body.epoch] || !body.sealed[this.me.id]) return;
    let key;
    try { key = await C.kemOpen(this.me.kemPriv, ctx('rekey', this.roomId) + '|' + body.epoch, unb64(body.sealed[this.me.id])); } catch { return; }
    this.keys[body.epoch] = key;
    if (body.epoch > this.epoch) { this.epoch = body.epoch; this.lastRekey = p; }
    await this.save();
    this.emit('epoch');
    const held = this.heldPackets.get(body.epoch) || [];
    this.heldPackets.delete(body.epoch);
    for (const [d, from] of held) await this.onPacket(d, from);
  }

  async kick(memberId) {
    const m = this.roster.members[memberId];
    if (!this.admin || !m || memberId === this.me.id) return;
    const members = { ...this.roster.members, [memberId]: { ...m, removed: true, removedAt: Date.now() } };
    await this.setRoster({ ...this.roster, version: this.roster.version + 1, members });
    await this.broadcastRoster(); // under the old key, so the removed device learns it and wipes itself
    await this.rotateKey(); // the removed member never learns the new key
    await this.broadcastRoster();
    await this.save();
  }

  // ---------- messages ----------

  async onRoomPacket(p, from) {
    switch (p.type) {
      case 'msg': return this.acceptEnvelope(p.env, p.sig);
      case 'chunk': return this.onChunk(p);
      case 'roster': return this.onRoster(p);
      case 'sync_req': this.onSyncRequest(p, from).catch(() => {}); return;
      case 'sync_resp':
        for (const it of p.items || []) await this.acceptEnvelope(it.env, it.sig);
        return;
      case 'media_req': this.onMediaRequest(p, from).catch(() => {}); return;
      case 'leave': return this.onLeave(p);
      case 'close': return this.onClose(p);
    }
  }

  async sendEnvelope(fields) {
    const env = { v: 1, id: hex(await C.random(16)), from: this.me.id, ts: Date.now(), ...fields };
    const envBytes = json(env);
    const sig = await C.sign(this.me.sigPriv, envBytes, ctx('msg', this.roomId));
    const envB64 = b64(envBytes);
    const sigB64 = b64(sig);
    await this.storeMessage(env, envB64, sigB64);
    await this.sendRoom({ type: 'msg', env: envB64, sig: sigB64 }, { store: true });
    return env;
  }

  sendText(text) {
    text = text.trim();
    if (!text) return;
    return this.sendEnvelope({ kind: 'text', text: text.slice(0, 20000) });
  }

  async sendMedia(blob, kind, name, extra = {}) {
    if (blob.size > MAX_MEDIA) throw new Error('Datei ist größer als 50 MB.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const key = await C.random(32);
    const mid = hex(await C.random(16));
    const ct = await C.seal(key, bytes, enc.encode('media|' + mid));
    const media = {
      mid, mime: blob.type || 'application/octet-stream', name: String(name || '').slice(0, 120), size: blob.size,
      key: b64(key), hash: b64(await C.sha256(ct)), ...extra,
    };
    await store.putMedia(this.roomId, mid, ct);
    const env = await this.sendEnvelope({ kind, media });
    this.sendChunks(mid, ct, null);
    return env;
  }

  async sendChunks(mid, ct, to) {
    const n = Math.ceil(ct.length / CHUNK);
    for (let i = 0; i < n; i++) {
      await this.sendRoom({ type: 'chunk', mid, i, n, data: b64(ct.subarray(i * CHUNK, (i + 1) * CHUNK)) }, { store: !to, to });
      this.emit('upload', { mid, done: i + 1, n });
      await sleep(25); // stay below the relay's rate limit
    }
  }

  async acceptEnvelope(envB64, sigB64) {
    if (typeof envB64 !== 'string' || typeof sigB64 !== 'string') return;
    const envBytes = unb64(envB64);
    let env;
    try { env = parse(envBytes); } catch { return; }
    if (!env.id || this.messages.has(env.id)) return;
    const m = this.roster?.members[env.from];
    if (!m) {
      if (this.orphans.length < 500) this.orphans.push({ envB64, sigB64 });
      return;
    }
    if (m.removed && !(env.ts < m.removedAt)) return; // removed members cannot post anymore
    if (!(await C.verify(unb64(m.sig), envBytes, unb64(sigB64), ctx('msg', this.roomId)))) return;
    await this.storeMessage(env, envB64, sigB64);
  }

  async storeMessage(env, envB64, sigB64) {
    this.messages.set(env.id, { env, envB64, sigB64 });
    const rec = json({ env, envB64, sigB64 });
    await store.putMsg(this.roomId, env.id, await C.seal(this.vaultKey, rec, enc.encode('msg|' + this.roomId)));
    this.emit('message', { env });
    if (env.media && !(await store.hasMedia(this.roomId, env.media.mid))) this.watchMedia(env.media.mid);
  }

  sortedMessages() {
    return [...this.messages.values()].map((m) => m.env).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  }

  memberName(id) {
    return this.roster?.members[id]?.name ?? 'Unbekannt';
  }

  // ---------- media ----------

  watchMedia(mid) {
    if (this.mediaWaiting.has(mid)) return;
    this.mediaWaiting.add(mid);
    let tries = 0;
    const tick = async () => {
      if (!this.mediaWaiting.has(mid) || this.closed) return;
      const buf = this.media.get(mid);
      if (!buf || buf.stalled) await this.sendRoom({ type: 'media_req', mid });
      if (buf) buf.stalled = true;
      if (++tries < 8) setTimeout(tick, 6000 * tries);
    };
    setTimeout(tick, 5000);
  }

  async onChunk(p) {
    if (typeof p.mid !== 'string' || !(p.n > 0) || p.n > 400 || !(p.i >= 0 && p.i < p.n)) return;
    if (!this.mediaWaiting.has(p.mid) && (await store.hasMedia(this.roomId, p.mid))) return;
    let buf = this.media.get(p.mid);
    if (!buf || buf.n !== p.n) { buf = { n: p.n, parts: new Array(p.n), got: 0 }; this.media.set(p.mid, buf); }
    buf.stalled = false;
    if (!buf.parts[p.i]) { buf.parts[p.i] = unb64(p.data); buf.got++; }
    this.emit('download', { mid: p.mid, done: buf.got, n: buf.n });
    if (buf.got < buf.n) return;
    const ct = concat(...buf.parts);
    const env = [...this.messages.values()].find((m) => m.env.media?.mid === p.mid)?.env;
    if (!env || b64(await C.sha256(ct)) !== env.media.hash) {
      this.media.delete(p.mid); // corrupt or unknown – wait for a resend
      return;
    }
    this.media.delete(p.mid);
    this.mediaWaiting.delete(p.mid);
    await store.putMedia(this.roomId, p.mid, ct);
    this.emit('media', { mid: p.mid });
  }

  async onMediaRequest(p, from) {
    if (!from || typeof p.mid !== 'string') return;
    const ct = await store.getMedia(this.roomId, p.mid);
    if (ct) {
      await sleep(Math.random() * 1500);
      this.sendChunks(p.mid, ct, from);
    }
  }

  async mediaBlob(media) {
    const ct = await store.getMedia(this.roomId, media.mid);
    if (!ct) return null;
    const pt = await C.open(unb64(media.key), ct, enc.encode('media|' + media.mid));
    return new Blob([pt], { type: media.mime });
  }

  // ---------- redundancy: peer-to-peer history sync ----------

  async requestSync() {
    const have = this.sortedMessages().slice(-SYNC_LIMIT).map((m) => m.id);
    // Signed and bound to our relay peer id, so nobody can ask for another
    // member's history (e.g. the admin's, to bypass the history lock).
    const body = json({ member: this.me.id, peer: this.myPeer, epoch: this.epoch, have });
    const sig = await C.sign(this.me.sigPriv, body, ctx('sync', this.roomId));
    await this.sendRoom({ type: 'sync_req', body: b64(body), sig: b64(sig) });
  }

  async onSyncRequest(p, from) {
    if (!from || typeof p.body !== 'string' || typeof p.sig !== 'string') return;
    const body = unb64(p.body);
    const req = parse(body);
    const members = this.roster?.members;
    const m = members && Object.hasOwn(members, req.member) ? members[req.member] : null;
    if (!m || m.removed || req.member === this.me.id || req.peer !== from) return;
    if (!(await C.verify(unb64(m.sig), body, unb64(p.sig), ctx('sync', this.roomId)))) return;
    await sleep(Math.random() * 1200);
    if (req.epoch < this.epoch && this.lastRekey) this.send(await this.seal('j', this.lastRekey), { to: from });
    await this.broadcastRoster(from);
    const have = new Set(Array.isArray(req.have) ? req.have : []);
    const items = [...this.messages.values()]
      .filter((x) => !have.has(x.env.id) && x.env.ts >= (m.since || 0))
      .sort((a, b) => a.env.ts - b.env.ts)
      .slice(-SYNC_LIMIT)
      .map((x) => ({ env: x.envB64, sig: x.sigB64 }));
    for (let i = 0; i < items.length; i += 20) {
      await this.sendRoom({ type: 'sync_resp', items: items.slice(i, i + 20) }, { to: from });
      await sleep(30);
    }
  }

  // ---------- leaving & closing ----------

  async leave() {
    if (this.admin) throw new Error('Als Initiator kannst du den Raum nur schließen.');
    const body = json({ member: this.me.id, ts: Date.now() });
    const sig = await C.sign(this.me.sigPriv, body, ctx('leave', this.roomId));
    await this.sendRoom({ type: 'leave', body: b64(body), sig: b64(sig) }, { store: true });
    await sleep(300);
    await this.destroy('left');
  }

  async onLeave(p) {
    if (!this.admin) return;
    const body = parse(unb64(p.body));
    const m = this.roster.members[body.member];
    if (!m || m.removed) return;
    if (await C.verify(unb64(m.sig), unb64(p.body), unb64(p.sig), ctx('leave', this.roomId))) await this.kick(body.member);
  }

  async closeRoom() {
    if (!this.admin) return;
    const body = json({ room: this.roomId, ts: Date.now() });
    const sig = await C.sign(this.me.sigPriv, body, ctx('close', this.roomId));
    await this.sendRoom({ type: 'close', body: b64(body), sig: b64(sig) }, { store: true });
    await sleep(300);
    await this.destroy('closed');
  }

  async onClose(p) {
    if (await C.verify(this.adminSig, unb64(p.body), unb64(p.sig), ctx('close', this.roomId))) await this.destroy('closed');
  }

  // Wipes everything about this room from this device.
  async destroy(reason) {
    this.disconnect();
    await store.wipeRoom(this.roomId);
    this.setState('gone', { reason });
  }
}
