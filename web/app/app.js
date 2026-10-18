// Nullraum UI. All user-provided content is inserted as text, never as HTML.

import { C } from './crypto.js';
import { store } from './store.js';
import { Room, deriveRoom, readHeader, MAX_MEDIA } from './room.js';

const $app = document.getElementById('app');
let room = null; // the open Room
const blobUrls = new Map();

// ---------- tiny DOM helpers ----------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  lock: '<path d="M7 10V7a5 5 0 0 1 10 0v3"/><rect x="4" y="10" width="16" height="11" rx="2.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  enter: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5M15 12H3"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/>',
  clip: '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14 9l2 2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  print: '<path d="M6 9V2h12v7"/><rect x="6" y="14" width="12" height="8"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
};

function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ic');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name]; // static markup only
  return s;
}

function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), 3200);
}

function show(...els) {
  $app.replaceChildren(...els);
  $app.querySelector('[autofocus]')?.focus();
}

function topbar(...right) {
  return h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '../' }, h('span', { class: 'brand-mark' }), 'Nullraum'),
    h('div', { class: 'topbar-right' }, right));
}

function busy(text) {
  show(topbar(), h('main', { class: 'center' }, h('div', { class: 'card narrow busy' }, h('div', { class: 'spinner' }), h('p', null, text))));
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Kopiert.'); } catch { toast('Kopieren nicht möglich – bitte abschreiben.', true); }
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts) => new Date(ts).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

// ---------- home ----------

async function home() {
  room?.disconnect();
  room = null;
  for (const u of blobUrls.values()) URL.revokeObjectURL(u);
  blobUrls.clear();
  const ids = await store.vaultIds().catch(() => []);

  const codeInput = h('input', { class: 'code-input', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Raumcode' });
  const join = async (e) => {
    e.preventDefault();
    let code;
    try { code = await C.parseRoomCode(codeInput.value); } catch (err) { return toast(err.message, true); }
    enterCode(code);
  };

  show(
    topbar(),
    h('main', { class: 'home' },
      h('section', { class: 'hero-mini' },
        h('span', { class: 'eyebrow' }, icon('shield'), 'Post-Quantum · Ende-zu-Ende · ohne Konto'),
        h('h1', null, 'Ein Code. Ein Raum.', h('br'), h('span', { class: 'grad' }, 'Niemand sonst.')),
        h('p', { class: 'lead' }, 'Erstelle einen Raum und gib den Code weiter: auf Papier, persönlich oder über einen Kanal deiner Wahl. Wer den Code hat, kann anklopfen. Hinein kommt nur, wen du bestätigst.')),
      h('div', { class: 'grid2' },
        h('div', { class: 'card action' },
          h('div', { class: 'action-ic' }, icon('plus')),
          h('h2', null, 'Raum erstellen'),
          h('p', null, 'Neuer Raum, neuer Code, neue Schlüssel. Du bist Initiator und entscheidest, wer hineinkommt.'),
          h('button', { class: 'btn primary', onclick: createView }, 'Raum erstellen')),
        h('form', { class: 'card action', onsubmit: join },
          h('div', { class: 'action-ic' }, icon('enter')),
          h('h2', null, 'Raum betreten'),
          h('p', null, 'Code eingeben. Bindestriche, Leerzeichen sowie Groß- und Kleinschreibung sind egal.'),
          codeInput,
          h('button', { class: 'btn', type: 'submit' }, 'Weiter'))),
      ids.length
        ? h('div', { class: 'device-note' },
            icon('lock'),
            h('span', null, `Auf diesem Gerät liegen ${ids.length} verschlüsselte${ids.length === 1 ? 'r Raum' : ' Räume'}. Zum Öffnen den Code eingeben.`),
            h('button', { class: 'btn ghost danger small', onclick: panic }, icon('trash'), 'Alles löschen'))
        : null));
}

async function panic() {
  if (!confirm('Alle Räume, Schlüssel, Nachrichten und Medien auf diesem Gerät unwiderruflich löschen?')) return;
  await store.wipeAll();
  toast('Alles gelöscht.');
  home();
}

// ---------- create ----------

function protectionFields(kind, state) {
  if (kind === 'password') {
    return [
      h('label', null, 'Passwort', h('input', { type: 'password', autocomplete: 'new-password', oninput: (e) => (state.password = e.target.value) })),
      h('p', { class: 'hint' }, 'Mindestens 10 Zeichen. Teile es auf einem anderen Weg als den Code.'),
    ];
  }
  if (kind === 'key') {
    return [h('p', { class: 'hint' }, 'Es wird ein zweiter, zufälliger Schlüssel erzeugt (120 Bit). Gib ihn getrennt vom Code weiter, zum Beispiel den Code auf Papier und den Schlüssel mündlich.')];
  }
  if (kind === 'questions') {
    return [0, 1, 2].map((i) => h('div', { class: 'qa' },
      h('label', null, `Frage ${i + 1}`, h('input', { placeholder: 'z. B. Wo haben wir uns kennengelernt?', oninput: (e) => (state.q[i] = e.target.value) })),
      h('label', null, 'Antwort', h('input', { type: 'password', oninput: (e) => (state.a[i] = e.target.value) }))))
      .concat(h('p', { class: 'hint' }, 'Bei Antworten sind Groß- und Kleinschreibung sowie mehrfache Leerzeichen egal. Wähle Antworten, die nur eingeweihte Personen kennen.'));
  }
  return [h('p', { class: 'hint' }, 'Nur der Code und deine Bestätigung schützen den Raum. Der Code hat 150 Bit Zufall, das ist bereits sehr stark.')];
}

function createView() {
  const st = { kind: 'none', password: '', q: ['', '', ''], a: ['', '', ''] };
  const fields = h('div', { class: 'prot-fields' }, protectionFields('none', st));
  const tabs = h('div', { class: 'seg', role: 'tablist' },
    [['none', 'Nur Code'], ['password', 'Passwort'], ['key', 'Zweitschlüssel'], ['questions', '3 Fragen']].map(([k, label]) =>
      h('button', {
        type: 'button', class: k === 'none' ? 'on' : '', role: 'tab',
        onclick: (e) => {
          st.kind = k;
          tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
          fields.replaceChildren(...protectionFields(k, st));
        },
      }, label)));
  const roomName = h('input', { required: true, maxlength: 60, placeholder: 'z. B. Familie', autofocus: true });
  const myName = h('input', { required: true, maxlength: 40, placeholder: 'Wie sollen dich andere sehen?' });
  const history = h('input', { type: 'checkbox' });

  const submit = async (e) => {
    e.preventDefault();
    let secretInput = null;
    let secondKey = null;
    const protection = { type: st.kind };
    if (st.kind === 'password') {
      if (st.password.length < 10) return toast('Das Passwort braucht mindestens 10 Zeichen.', true);
      secretInput = st.password;
    } else if (st.kind === 'key') {
      secondKey = await C.newSecondKey();
      secretInput = secondKey;
    } else if (st.kind === 'questions') {
      if (st.q.some((q) => !q.trim()) || st.a.some((a) => !a.trim())) return toast('Bitte alle drei Fragen und Antworten ausfüllen.', true);
      protection.questions = st.q.map((q) => q.trim().slice(0, 200));
      secretInput = st.a;
    }
    if (protection.type !== 'none') protection.salt = btoa(String.fromCharCode(...(await C.random(16))));
    busy('Schlüssel werden erzeugt: Argon2id, ML-KEM-768 + X25519, ML-DSA-65 …');
    try {
      const code = await C.newRoomCode();
      const r = await Room.create({ code, roomName: roomName.value.trim(), myName: myName.value.trim(), protection, secretInput, history: history.checked });
      codeReveal(r, secondKey);
    } catch (err) {
      toast('Fehler: ' + err.message, true);
      createView();
    }
  };

  show(topbar(h('button', { class: 'btn ghost small', onclick: home }, icon('back'), 'Zurück')),
    h('main', { class: 'center' },
      h('form', { class: 'card form', onsubmit: submit },
        h('h2', null, 'Neuen Raum erstellen'),
        h('label', null, 'Raumname', h('small', null, 'Nur für Mitglieder sichtbar, Ende-zu-Ende verschlüsselt'), roomName),
        h('label', null, 'Dein Name', myName),
        h('fieldset', null, h('legend', null, 'Zusätzlicher Schutz'), tabs, fields),
        h('label', { class: 'check' }, history, h('span', null, 'Neue Mitglieder dürfen frühere Nachrichten sehen', h('small', null, 'Aus: Vor jeder Aufnahme wird der Raumschlüssel gewechselt. Neue Mitglieder können ältere Nachrichten dann kryptografisch nicht lesen.'))),
        h('button', { class: 'btn primary wide', type: 'submit' }, icon('key'), 'Raum & Schlüssel erzeugen'))));
}

function codeBlock(code) {
  return h('div', { class: 'code-display' }, code.split('-').map((g) => h('span', null, g)));
}

function printCode(code, secondKey, roomName) {
  const sheet = document.getElementById('print-sheet');
  sheet.replaceChildren(
    h('h1', null, 'Nullraum'),
    h('p', null, 'Raumcode', roomName ? ` · ${roomName}` : ''),
    codeBlock(code),
    secondKey ? [h('p', null, 'Zweitschlüssel (getrennt aufbewahren!)'), codeBlock(secondKey)] : null,
    h('p', { class: 'small' }, 'Wer diesen Code hat, kann um Einlass bitten. Hinein kommt nur, wen der Initiator bestätigt. Nach der Weitergabe vernichten.'));
  window.print();
}

function codeReveal(r, secondKey) {
  show(topbar(),
    h('main', { class: 'center' },
      h('div', { class: 'card form reveal' },
        h('span', { class: 'eyebrow' }, icon('check'), 'Raum erstellt'),
        h('h2', null, 'Dein Raumcode'),
        h('p', null, 'Das ist der einzige Weg in deinen Raum. Schreib ihn ab, drucke ihn aus oder teile ihn über einen Kanal deiner Wahl. Er wird nirgends gespeichert, auch nicht auf diesem Gerät. Ohne Code kommst du selbst nicht mehr hinein.'),
        codeBlock(r.code),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: () => copyText(r.code) }, icon('copy'), 'Kopieren'),
          h('button', { class: 'btn small', onclick: () => printCode(r.code, secondKey, r.roomName) }, icon('print'), 'Drucken')),
        secondKey ? [
          h('h3', null, 'Zweitschlüssel'),
          h('p', null, 'Separat weitergeben. Wer beitreten will, braucht Code und Zweitschlüssel.'),
          codeBlock(secondKey),
          h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => copyText(secondKey) }, icon('copy'), 'Kopieren')),
        ] : null,
        h('button', { class: 'btn primary wide', onclick: () => openRoom(r) }, 'Raum betreten'))));
}

// ---------- entering with a code ----------

async function enterCode(code) {
  busy('Raumschlüssel werden abgeleitet (Argon2id) …');
  const d = await deriveRoom(code);
  let header = null;
  try { header = await readHeader(d); } catch { /* not ours */ }
  if (header) return unlockView(d, header);
  joinNameView(d);
}

function secretForm(protection, onSubmit, error) {
  const st = { a: ['', '', ''] };
  let input;
  let body;
  if (protection.type === 'password') {
    input = h('input', { type: 'password', autofocus: true, autocomplete: 'current-password' });
    body = h('label', null, 'Raum-Passwort', input);
  } else if (protection.type === 'key') {
    input = h('input', { class: 'code-input', autofocus: true, autocapitalize: 'characters', spellcheck: 'false', placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' });
    body = h('label', null, 'Zweitschlüssel', input);
  } else {
    body = (protection.questions || []).map((q, i) => h('label', null, q, h('input', { type: 'password', autofocus: i === 0, oninput: (e) => (st.a[i] = e.target.value) })));
  }
  return h('form', {
    class: 'card form narrow',
    onsubmit: (e) => { e.preventDefault(); onSubmit(protection.type === 'questions' ? st.a : input.value); },
  },
  h('span', { class: 'eyebrow' }, icon('shield'), 'Zusätzlicher Schutz'),
  h('h2', null, protection.type === 'questions' ? 'Drei Sicherheitsfragen' : 'Dieser Raum ist zusätzlich geschützt'),
  error ? h('p', { class: 'error' }, error) : null,
  body,
  h('button', { class: 'btn primary wide', type: 'submit' }, 'Bestätigen'));
}

function unlockView(d, header, error) {
  const back = h('button', { class: 'btn ghost small', onclick: home }, icon('back'), 'Zurück');
  const go = async (input) => {
    busy('Entschlüsseln …');
    try {
      openRoom(await Room.unlock(d, header, input));
    } catch (err) {
      unlockView(d, header, err.message);
    }
  };
  const prot = header.protection || { type: 'none' };
  if (prot.type !== 'none') return show(topbar(back), h('main', { class: 'center' }, secretForm(prot, go, error)));
  if (!error) return go(null);
  show(topbar(back), h('main', { class: 'center' }, h('div', { class: 'card form narrow' }, h('h2', null, 'Fehler'), h('p', { class: 'error' }, error))));
}

function joinNameView(d) {
  const name = h('input', { required: true, maxlength: 40, autofocus: true, placeholder: 'Wie soll dich der Initiator sehen?' });
  show(topbar(h('button', { class: 'btn ghost small', onclick: home }, icon('back'), 'Zurück')),
    h('main', { class: 'center' },
      h('form', {
        class: 'card form narrow',
        onsubmit: async (e) => {
          e.preventDefault();
          const r = await Room.startJoin(d, name.value.trim());
          room = r;
          r.addEventListener('state', (ev) => joinState(r, ev.detail));
          joinState(r, { state: 'joining' });
        },
      },
      h('h2', null, 'Anklopfen'),
      h('p', null, 'Dein Name wird verschlüsselt an den Initiator übertragen. Danach entscheidet er, ob du hineinkommst.'),
      h('label', null, 'Dein Name', name),
      h('button', { class: 'btn primary wide', type: 'submit' }, 'Anklopfen'))));
}

function joinState(r, s) {
  const back = h('button', { class: 'btn ghost small', onclick: home }, icon('back'), 'Abbrechen');
  const wait = (title, text, extra) => show(topbar(back), h('main', { class: 'center' },
    h('div', { class: 'card form narrow busy' }, h('div', { class: 'pulse' }), h('h2', null, title), h('p', null, text), extra)));
  switch (s.state) {
    case 'joining':
      return wait('Warte auf den Initiator …', 'Der Initiator des Raums muss online sein, um dich hereinzulassen. Lass diese Seite offen, dann klopfst du automatisch erneut an.');
    case 'need-secret':
      return show(topbar(back), h('main', { class: 'center' }, secretForm(s.protection, async (input) => {
        busy('Antwort wird gehärtet (Argon2id) …');
        await r.submitSecret(input);
      }, s.error)));
    case 'waiting':
      return wait('Anfrage gesendet', 'Der Initiator sieht jetzt deine Anfrage. Für maximale Sicherheit vergleicht ihr diese Sicherheitsnummer, etwa am Telefon. Stimmt sie überein, sitzt niemand dazwischen.',
        h('div', { class: 'fingerprint' }, s.fingerprint));
    case 'member':
      return openRoom(r);
    case 'denied':
      return show(topbar(), h('main', { class: 'center' }, h('div', { class: 'card form narrow' }, h('h2', null, 'Abgelehnt'), h('p', null, 'Der Initiator hat deine Anfrage abgelehnt.'), h('button', { class: 'btn wide', onclick: home }, 'Zur Startseite'))));
    case 'conflict':
      return show(topbar(), h('main', { class: 'center' }, h('div', { class: 'card form narrow warn' }, h('h2', null, 'Achtung: mögliche Täuschung'),
        h('p', null, 'Zwei verschiedene Teilnehmer haben sich als Initiator dieses Raums ausgegeben. Jemand anderes mit dem Code versucht vermutlich, sich dazwischenzuschalten. Der Beitritt wurde abgebrochen. Sprich mit dem echten Initiator und vergleicht die Sicherheitsnummer.'),
        h('button', { class: 'btn wide', onclick: home }, 'Zur Startseite'))));
  }
}

// ---------- room ----------

function openRoom(r) {
  room = r;
  const msgList = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite' });
  const requests = h('div', { class: 'requests' });
  const status = h('span', { class: 'status' });
  const title = h('div', { class: 'room-title' });
  const drawer = h('aside', { class: 'drawer' });
  const progress = h('div', { class: 'progress' });
  const msgEls = new Map();

  const fileInput = h('input', { type: 'file', class: 'hidden', multiple: true, accept: 'image/*,video/*,audio/*,*/*' });
  const text = h('textarea', { rows: 1, placeholder: 'Nachricht … (Ende-zu-Ende verschlüsselt)', 'aria-label': 'Nachricht', autofocus: true });
  const micBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Sprachnachricht', onclick: () => toggleRecord() }, icon('mic'));

  const updateTitle = () => {
    title.replaceChildren(
      h('strong', null, r.roomName || 'Raum'),
      h('span', { class: 'badge' }, icon('lock'), `PQ · Epoche ${r.epoch}`));
    const online = r.ws?.readyState === WebSocket.OPEN;
    status.textContent = online ? `${r.peers.size + 1} online` : 'verbinde …';
    status.className = 'status' + (online ? ' on' : '');
  };

  const renderRequests = () => {
    requests.replaceChildren(...[...r.pendingRequests.values()].map((q) =>
      h('div', { class: 'request' },
        h('div', null,
          h('strong', null, q.name), ' möchte beitreten',
          h('div', { class: 'fp-line' }, 'Sicherheitsnummer ', h('code', null, q.fingerprint))),
        h('div', { class: 'row' },
          h('button', { class: 'btn small primary', onclick: () => r.approve(q.peer) }, icon('check'), 'Aufnehmen'),
          h('button', { class: 'btn small ghost', onclick: () => r.deny(q.peer) }, icon('x'), 'Ablehnen')))));
  };

  const mediaNode = (env) => {
    const m = env.media;
    const box = h('div', { class: 'media-box', 'data-mid': m.mid });
    fillMedia(box, env);
    return box;
  };

  const fillMedia = async (box, env) => {
    const m = env.media;
    let url = blobUrls.get(m.mid);
    if (!url) {
      const blob = await r.mediaBlob(m).catch(() => null);
      if (!blob) {
        box.replaceChildren(h('div', { class: 'media-wait' }, h('div', { class: 'spinner small' }), `${env.kind === 'audio' ? 'Sprachnachricht' : m.name || 'Datei'} · ${fmtSize(m.size)} · wird geladen …`));
        return;
      }
      url = URL.createObjectURL(blob);
      blobUrls.set(m.mid, url);
    }
    let el;
    if (env.kind === 'image') el = h('img', { src: url, alt: m.name || 'Bild', loading: 'lazy' });
    else if (env.kind === 'video') el = h('video', { src: url, controls: true, preload: 'metadata', playsinline: true });
    else if (env.kind === 'audio') el = h('audio', { src: url, controls: true, preload: 'metadata' });
    else el = h('a', { class: 'file-link', href: url, download: m.name || 'datei' }, icon('file'), h('span', null, m.name || 'Datei', h('small', null, fmtSize(m.size))));
    box.replaceChildren(el);
    if (env.kind === 'image') el.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
  };

  const msgNode = (env) => {
    const mine = env.from === r.me.id;
    return h('div', { class: 'msg' + (mine ? ' mine' : '') },
      mine ? null : h('div', { class: 'who' }, r.memberName(env.from)),
      env.media ? mediaNode(env) : null,
      env.text ? h('div', { class: 'text' }, env.text) : null,
      h('div', { class: 'meta' }, fmtTime(env.ts), h('span', { class: 'sig', title: 'Signatur (ML-DSA-65) geprüft' }, icon('check'))));
  };

  const renderMessages = () => {
    const atBottom = msgList.scrollHeight - msgList.scrollTop - msgList.clientHeight < 80;
    const nodes = [];
    let lastDay = '';
    const sorted = r.sortedMessages();
    if (!sorted.length) {
      nodes.push(h('div', { class: 'empty' }, icon('lock'), h('p', null, 'Noch keine Nachrichten.'), h('small', null, 'Alles hier ist mit post-quantum-sicheren Schlüsseln Ende-zu-Ende verschlüsselt. Der Server sieht nur Rauschen.')));
    }
    for (const env of sorted) {
      const day = fmtDay(env.ts);
      if (day !== lastDay) { nodes.push(h('div', { class: 'day' }, day)); lastDay = day; }
      let el = msgEls.get(env.id);
      if (!el) { el = msgNode(env); msgEls.set(env.id, el); }
      nodes.push(el);
    }
    msgList.replaceChildren(...nodes);
    if (atBottom) msgList.scrollTop = msgList.scrollHeight;
  };

  const drawerMembers = () => {
    const members = Object.entries(r.roster.members).filter(([, m]) => !m.removed);
    drawer.replaceChildren(
      h('div', { class: 'drawer-head' }, h('h3', null, 'Raum'), h('button', { class: 'icon-btn', onclick: () => drawer.classList.remove('open') }, icon('x'))),
      h('h4', null, `Mitglieder (${members.length})`),
      h('ul', { class: 'members' }, members.map(([id, m]) =>
        h('li', null,
          h('span', { class: 'avatar' }, (m.name || '?').slice(0, 1).toUpperCase()),
          h('span', { class: 'mname' }, m.name, m.admin ? h('small', null, 'Initiator') : null, id === r.me.id ? h('small', null, 'du') : null),
          r.admin && id !== r.me.id ? h('button', {
            class: 'btn ghost small danger', onclick: async () => {
              if (confirm(`${m.name} entfernen? Der Raumschlüssel wird danach gewechselt.`)) { await r.kick(id); toast('Entfernt, neuer Schlüssel verteilt.'); }
            },
          }, 'Entfernen') : null))),
      h('h4', null, 'Raumcode'),
      h('p', { class: 'hint' }, 'Gib den Code nur kontrolliert weiter. Jede Beitrittsanfrage musst du bestätigen.'),
      codeBlock(r.code),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => copyText(r.code) }, icon('copy'), 'Kopieren'),
        h('button', { class: 'btn small', onclick: () => printCode(r.code, null, r.roomName) }, icon('print'), 'Drucken')),
      h('h4', null, 'Sicherheit'),
      h('dl', { class: 'facts' },
        h('dt', null, 'Schlüsselaustausch'), h('dd', null, 'ML-KEM-768 + X25519 (HPKE)'),
        h('dt', null, 'Signaturen'), h('dd', null, 'ML-DSA-65'),
        h('dt', null, 'Verschlüsselung'), h('dd', null, 'XChaCha20-Poly1305, 256 Bit'),
        h('dt', null, 'Schutz'), h('dd', null, { none: 'Nur Code', password: 'Code + Passwort', key: 'Code + Zweitschlüssel', questions: 'Code + 3 Fragen' }[r.protection?.type || 'none']),
        h('dt', null, 'Verlauf für Neue'), h('dd', null, r.history ? 'sichtbar' : 'gesperrt'),
        h('dt', null, 'Deine ID'), h('dd', null, h('code', null, r.me.id))),
      r.admin ? h('button', { class: 'btn small wide', onclick: async () => { await r.rotateKey(); await r.broadcastRoster(); toast('Neuer Raumschlüssel verteilt.'); } }, icon('refresh'), 'Raumschlüssel jetzt wechseln') : null,
      h('div', { class: 'danger-zone' },
        r.admin
          ? h('button', { class: 'btn danger wide', onclick: async () => { if (confirm('Raum für ALLE schließen? Alle Geräte löschen ihre Kopie.')) await r.closeRoom(); } }, icon('trash'), 'Raum für alle schließen')
          : h('button', { class: 'btn danger wide', onclick: async () => { if (confirm('Raum verlassen und alle Daten auf diesem Gerät löschen?')) await r.leave(); } }, icon('trash'), 'Raum verlassen')));
  };

  const send = async () => {
    const v = text.value;
    if (!v.trim()) return;
    text.value = '';
    text.style.height = '';
    await r.sendText(v);
  };

  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  text.addEventListener('input', () => { text.style.height = ''; text.style.height = Math.min(text.scrollHeight, 160) + 'px'; });

  const sendFiles = async (files) => {
    for (const f of files) {
      try {
        if (f.size > MAX_MEDIA) { toast(`${f.name}: größer als 50 MB`, true); continue; }
        let blob = f;
        let kind = 'file';
        if (f.type.startsWith('image/') && f.type !== 'image/gif') { blob = await stripImage(f); kind = 'image'; }
        else if (f.type === 'image/gif') kind = 'image';
        else if (f.type.startsWith('video/')) kind = 'video';
        else if (f.type.startsWith('audio/')) kind = 'audio';
        await r.sendMedia(blob, kind, f.name);
      } catch (err) { toast(err.message, true); }
    }
  };
  fileInput.addEventListener('change', () => { sendFiles([...fileInput.files]); fileInput.value = ''; });

  // voice notes
  let rec = null;
  const toggleRecord = async () => {
    if (rec) { rec.stop(); return; }
    if (!window.isSecureContext) return toast('Sprachnachrichten brauchen HTTPS (oder localhost).', true);
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('Kein Mikrofonzugriff.', true); }
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const chunks = [];
    const started = Date.now();
    rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(timer);
      rec = null;
      micBtn.classList.remove('rec');
      micBtn.replaceChildren(icon('mic'));
      const blob = new Blob(chunks, { type: (mime || 'audio/webm').split(';')[0] });
      if (Date.now() - started < 600) return;
      try { await r.sendMedia(blob, 'audio', 'Sprachnachricht', { dur: Math.round((Date.now() - started) / 1000) }); } catch (err) { toast(err.message, true); }
    };
    rec.start(1000);
    micBtn.classList.add('rec');
    const timer = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      micBtn.replaceChildren(icon('stop'), h('span', { class: 'rec-time' }, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`));
      if (s >= 600) rec?.stop();
    }, 250);
  };

  // drag & drop and paste
  const main = h('main', { class: 'room' },
    requests,
    msgList,
    progress,
    h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); send(); } },
      h('button', { class: 'icon-btn', type: 'button', title: 'Bild, Video oder Datei', onclick: () => fileInput.click() }, icon('clip')),
      fileInput,
      text,
      micBtn,
      h('button', { class: 'icon-btn send', type: 'submit', title: 'Senden' }, icon('send'))));
  main.addEventListener('dragover', (e) => e.preventDefault());
  main.addEventListener('drop', (e) => { e.preventDefault(); sendFiles([...e.dataTransfer.files]); });
  text.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); sendFiles(files); }
  });

  show(
    h('header', { class: 'topbar room-bar' },
      h('a', { class: 'brand', href: '../' }, h('span', { class: 'brand-mark' })),
      title,
      h('div', { class: 'topbar-right' },
        status,
        h('button', { class: 'icon-btn', title: 'Raum & Mitglieder', onclick: () => { drawerMembers(); drawer.classList.add('open'); } }, icon('users')),
        h('button', { class: 'icon-btn', title: 'Sperren', onclick: () => { toast('Raum gesperrt. Schlüssel aus dem Speicher entfernt.'); home(); } }, icon('lock')))),
    main,
    drawer);

  const uploads = new Map();
  const renderProgress = () => {
    progress.replaceChildren(...[...uploads.values()].map((p) => {
      const fill = h('span');
      fill.style.width = Math.round((p.done / p.n) * 100) + '%'; // CSSOM is allowed by the CSP, style="" is not
      return h('div', { class: 'bar' }, fill, h('em', null, `${p.label} ${p.done}/${p.n}`));
    }));
  };

  r.addEventListener('message', () => renderMessages());
  r.addEventListener('media', (e) => {
    const box = msgList.querySelector(`[data-mid="${CSS.escape(e.detail.mid)}"]`);
    const env = [...r.messages.values()].find((m) => m.env.media?.mid === e.detail.mid)?.env;
    if (box && env) fillMedia(box, env);
  });
  r.addEventListener('upload', (e) => {
    const { mid, done, n } = e.detail;
    if (done >= n) uploads.delete(mid); else uploads.set(mid, { done, n, label: 'Senden' });
    renderProgress();
  });
  r.addEventListener('requests', renderRequests);
  r.addEventListener('peers', updateTitle);
  r.addEventListener('connection', updateTitle);
  r.addEventListener('epoch', updateTitle);
  r.addEventListener('roster', () => { updateTitle(); if (drawer.classList.contains('open')) drawerMembers(); });
  r.addEventListener('failed-attempt', (e) => toast(`Fehlgeschlagener Beitrittsversuch (${e.detail.count}/3) mit falschem Geheimnis.`, true));
  r.addEventListener('state', (e) => {
    if (e.detail.state !== 'gone') return;
    const why = { removed: 'Du wurdest aus dem Raum entfernt.', closed: 'Der Raum wurde geschlossen.', left: 'Du hast den Raum verlassen.' }[e.detail.reason];
    show(topbar(), h('main', { class: 'center' }, h('div', { class: 'card form narrow' }, h('h2', null, 'Raum beendet'), h('p', null, why, ' Alle lokalen Daten dieses Raums wurden gelöscht.'), h('button', { class: 'btn wide', onclick: home }, 'Zur Startseite'))));
  });

  updateTitle();
  renderMessages();
  renderRequests();
  if (r.state !== 'member') r.setState('member');
  if (!r.ws || r.ws.readyState > WebSocket.OPEN) r.connect();
  else if (r.ws.readyState === WebSocket.OPEN) r.requestSync();
  msgList.scrollTop = msgList.scrollHeight;
}

// Re-encodes photos so EXIF metadata (GPS position, camera serial …) never leaves the device.
async function stripImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return new Promise((res) => c.toBlob((b) => res(b), type, 0.88));
}

// ---------- boot ----------

(async () => {
  try {
    await C.random(1); // wait until the WASM crypto core is up
    home();
  } catch (e) {
    $app.replaceChildren(h('div', { class: 'boot' }, h('p', null, 'Der Kryptokern konnte nicht geladen werden: ' + e.message)));
  }
})();
