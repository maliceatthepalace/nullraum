# Nullraum – Hinweise für Claude

Post-quantum Ende-zu-Ende verschlüsselter Raum-Chat. Ein Code öffnet einen Raum, der Initiator bestätigt jedes Mitglied. Go-Relay + Browser-App, Krypto als WebAssembly.

Sprache: UI, Website, Doku und Commit-Messages auf **Deutsch**. Code-Kommentare auf Englisch (wie bestehender Code).

## Architektur

| Pfad | Inhalt |
|---|---|
| `internal/pqc` | alle Krypto-Primitive (Code-Format, Argon2id, HKDF, XChaCha20-Poly1305 + Padding, HPKE ML-KEM-768+X25519, ML-DSA-65, Fingerprint) |
| `cmd/wasm` | exportiert `internal/pqc` als `NullraumCrypto` für den Browser (läuft im Web Worker) |
| `internal/relay` | blindes WebSocket-Relay, RAM-Mailbox, Limits |
| `cmd/nullraum` | CLI `serve` / `client` (client = App lokal ausliefern, WS zum Relay proxyen) |
| `web/app` | Chat-App, Vanilla-JS-Module: `crypto.js` (Worker-RPC), `store.js` (IndexedDB), `room.js` (Protokoll), `app.js` (UI) |
| `web/site` | Website, wird auch auf GitHub Pages veröffentlicht |
| `web/web.go` | embed + Security-Header/CSP |
| `docs/PROTOCOL.md` | Protokollspezifikation, **muss bei jeder Protokolländerung mitgepflegt werden** |
| `SECURITY.md` | Bedrohungsmodell |
| `deploy/install.sh` | Ein-Befehl-Installation (Docker + Caddy + sslip.io) |
| `test/e2e` | Playwright-Test mit drei Nutzern |

## Harte Regeln

1. **Keine eigene Kryptografie.** Nur Go-Standardbibliothek (`crypto/mlkem`, `crypto/mldsa`, `crypto/hpke`, `crypto/hkdf`) und `golang.org/x/crypto`. Keine Krypto in JavaScript, keine JS-Kryptobibliotheken.
2. **Das Relay darf nie Klartext, Codes, Namen oder Schlüssel sehen.** Neue Pakettypen gehören in einen verschlüsselten Layer (`j`/`q`/`w`/`r`, siehe PROTOCOL.md).
3. **Keine Logs von IPs oder Inhalten, nichts auf die Festplatte des Servers.**
4. **Keine externen Ressourcen** (CDNs, Fonts, Analytics). Die CSP in `web/web.go` bleibt strikt: keine Inline-Skripte, kein `style="..."` (CSSOM via `el.style.x` ist ok).
5. **Nutzerinhalte nur als Text ins DOM** (`textContent`, `h()`-Helper), nie `innerHTML`.
6. Protokolländerungen müssen abwärtskompatibel sein oder die Version erhöhen (`nullraum/v1/...`-Labels).
7. Ehrlichkeit in Doku/Website: keine Sicherheitsversprechen, die nicht stimmen. Grenzen bleiben in SECURITY.md und auf der Website dokumentiert.

## Bauen & Testen

```sh
make            # WASM + Binary (Go >= 1.26)
make test       # go vet + go test
./bin/nullraum serve -addr 127.0.0.1:8080 &
cd test/e2e && npm i && npx playwright install chromium && node e2e.mjs
```

Web-Dateien sind per `go:embed` im Binary: nach Änderungen an `web/` neu bauen und den Server neu starten.
Die E2E-Tests laufen auch in CI (`.github/workflows/ci.yml`).

## Releases

Tag `vX.Y.Z` pushen → GitHub Actions baut Binaries (Linux/macOS/Windows, amd64/arm64) und das Docker-Image `ghcr.io/maliceatthepalace/nullraum`. Push auf `main` aktualisiert `:latest` und die Website.
