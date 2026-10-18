import { chromium } from 'playwright';
import zlib from 'node:zlib';

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const shots = process.env.SHOTS || '/work/shots';
const log = (...a) => console.log('•', ...a);
const browser = await chromium.launch();
const mk = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  p.on('console', (m) => m.type() === 'error' && console.log(`[${name} console]`, m.text()));
  p.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await p.goto(BASE + '/app/');
  await p.getByRole('button', { name: 'Raum erstellen' }).waitFor({ timeout: 20000 });
  return p;
};

// tiny PNG
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = x * 4; raw[o + 1] = y * 4; raw[o + 2] = 160; }
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const A = await mk('A');
await A.screenshot({ path: `${shots}/1-home.png` });
await A.getByRole('button', { name: 'Raum erstellen' }).click();
await A.getByPlaceholder('z. B. Familie').fill('Testraum');
await A.getByPlaceholder('Wie sollen dich andere sehen?').fill('Alice');
await A.getByRole('tab', { name: 'Passwort' }).click();
await A.locator('input[type=password]').fill('supergeheim123');
await A.screenshot({ path: `${shots}/2-create.png` });
await A.getByRole('button', { name: /Raum & Schlüssel erzeugen/ }).click();
await A.locator('.code-display').first().waitFor({ timeout: 30000 });
const code = (await A.locator('.code-display').first().locator('span').allTextContents()).join('-');
log('room code', code);
await A.screenshot({ path: `${shots}/3-code.png` });
await A.getByRole('button', { name: 'Raum betreten' }).click();
await A.locator('.status.on').waitFor({ timeout: 10000 });

async function knock(p, name, secret, wrongFirst) {
  await p.getByLabel('Raumcode').fill(code.toLowerCase().replaceAll('-', ' '));
  await p.getByRole('button', { name: 'Weiter' }).click();
  await p.getByPlaceholder('Wie soll dich der Initiator sehen?').fill(name);
  await p.getByRole('button', { name: 'Anklopfen' }).click();
  if (secret) {
    await p.getByText('Dieser Raum ist zusätzlich geschützt').waitFor({ timeout: 30000 });
    if (wrongFirst) {
      await p.locator('input[type=password]').fill('falsch-falsch');
      await p.getByRole('button', { name: 'Bestätigen' }).click();
      await p.getByText('Das war leider falsch.').waitFor({ timeout: 30000 });
      log(name, 'wrong password rejected ✓');
    }
    await p.locator('input[type=password]').fill(secret);
    await p.getByRole('button', { name: 'Bestätigen' }).click();
  }
  await p.locator('.fingerprint').waitFor({ timeout: 30000 });
  return (await p.locator('.fingerprint').textContent()).trim();
}

const B = await mk('B');
const fpB = await knock(B, 'Bob', 'supergeheim123', true);
await B.screenshot({ path: `${shots}/4-waiting.png` });
await A.locator('.request').waitFor({ timeout: 15000 });
const fpA = (await A.locator('.request code').textContent()).trim();
log('fingerprints', fpB, fpA, fpA === fpB ? 'MATCH ✓' : 'MISMATCH ✗');
await A.screenshot({ path: `${shots}/5-request.png` });
await A.getByRole('button', { name: 'Aufnehmen' }).click();
await B.locator('.composer').waitFor({ timeout: 20000 });
log('Bob admitted ✓');

await A.locator('textarea').fill('Hallo Bob, das hier ist post-quantum verschlüsselt 🔐');
await A.keyboard.press('Enter');
await B.getByText('Hallo Bob, das hier ist post-quantum').waitFor({ timeout: 15000 });
log('A→B text ✓');
await B.locator('textarea').fill('Hi Alice! <img src=x onerror=alert(1)>');
await B.keyboard.press('Enter');
await A.getByText('Hi Alice! <img src=x onerror=alert(1)>').waitFor({ timeout: 15000 });
log('B→A text (HTML rendered as text) ✓');

await B.locator('input[type=file]').setInputFiles({ name: 'bild.png', mimeType: 'image/png', buffer: png(64, 48) });
await A.locator('.msg .media-box img').waitFor({ timeout: 30000 });
log('B→A image ✓');
const big = Buffer.alloc(900 * 1024, 7);
await A.locator('input[type=file]').setInputFiles({ name: 'daten.bin', mimeType: 'application/octet-stream', buffer: big });
await B.locator('.file-link').waitFor({ timeout: 30000 });
log('A→B 900KB file (multi-chunk) ✓');
await A.screenshot({ path: `${shots}/6-room-A.png` });
await B.screenshot({ path: `${shots}/7-room-B.png` });

// Carol joins: history is off, so she must not see earlier messages
const Cc = await mk('C');
await knock(Cc, 'Carol', 'supergeheim123', false);
await A.locator('.request').waitFor({ timeout: 15000 });
await A.getByRole('button', { name: 'Aufnehmen' }).click();
await Cc.locator('.composer').waitFor({ timeout: 20000 });
await Cc.waitForTimeout(3000);
const carolSees = await Cc.locator('.msg').count();
log('Carol sees old messages:', carolSees, carolSees === 0 ? '✓ (history locked)' : '✗');
await B.locator('textarea').fill('Willkommen Carol');
await B.keyboard.press('Enter');
await Cc.getByText('Willkommen Carol').waitFor({ timeout: 15000 });
log('B→C after rekey ✓', await A.locator('.badge').textContent());

// kick Carol
A.on('dialog', (d) => d.accept());
await A.getByTitle('Raum & Mitglieder').click();
await A.screenshot({ path: `${shots}/8-drawer.png` });
await A.locator('.members li', { hasText: 'Carol' }).getByRole('button', { name: 'Entfernen' }).click();
await Cc.getByText('Du wurdest aus dem Raum entfernt.').waitFor({ timeout: 20000 });
log('Carol removed + wiped ✓', await A.locator('.badge').textContent());
await A.locator('.drawer .icon-btn').click();
await A.locator('textarea').fill('Nach dem Rauswurf');
await A.keyboard.press('Enter');
await B.getByText('Nach dem Rauswurf').waitFor({ timeout: 15000 });
log('A→B after kick ✓');

// Bob reloads: local encrypted history
await B.reload();
await B.getByLabel('Raumcode').fill(code);
await B.getByRole('button', { name: 'Weiter' }).click();
await B.locator('input[type=password]').fill('wrongpassword');
await B.getByRole('button', { name: 'Bestätigen' }).click();
await B.locator('.error').waitFor({ timeout: 30000 });
log('unlock with wrong password refused ✓');
await B.locator('input[type=password]').fill('supergeheim123');
await B.getByRole('button', { name: 'Bestätigen' }).click();
await B.getByText('Nach dem Rauswurf').waitFor({ timeout: 30000 });
await B.locator('.file-link').waitFor({ timeout: 10000 });
log('Bob unlocked local history incl. media ✓, messages:', await B.locator('.msg').count());

// offline delivery: Bob locks, Alice writes, Bob comes back
await B.getByTitle('Sperren').click();
await A.locator('textarea').fill('Während du weg warst');
await A.keyboard.press('Enter');
await A.waitForTimeout(500);
await B.getByLabel('Raumcode').fill(code);
await B.getByRole('button', { name: 'Weiter' }).click();
await B.locator('input[type=password]').fill('supergeheim123');
await B.getByRole('button', { name: 'Bestätigen' }).click();
await B.getByText('Während du weg warst').waitFor({ timeout: 30000 });
log('offline delivery ✓');

// site
const S = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
S.on('console', (m) => m.type() === 'error' && console.log('[site console]', m.text()));
await S.goto(BASE + '/');
await S.waitForTimeout(800);
await S.screenshot({ path: `${shots}/9-site.png` });
await S.screenshot({ path: `${shots}/9-site-full.png`, fullPage: true });
const M = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
await M.goto(BASE + '/'); await M.waitForTimeout(600);
await M.screenshot({ path: `${shots}/10-site-mobile.png` });
const overflow = await M.evaluate(() => document.documentElement.scrollWidth > innerWidth);
log('mobile horizontal overflow:', overflow);

await browser.close();
log('ALL DONE');
