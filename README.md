<p align="center"><img src="web/site/favicon.svg" width="72" alt=""></p>

<h1 align="center">Nullraum</h1>
<p align="center"><b>Ein Code. Ein Raum. Niemand sonst.</b><br>
Post-quantum Ende-zu-Ende verschlüsselter Raum-Chat. Ohne Konto, ohne Telefonnummer, selbst hostbar.</p>

---

Nullraum ist ein Chat für geschlossene Räume:

1. **Raum erstellen.** Du bekommst einen Code, z. B. `7KQF-3MXZ-9TBC-HW2R-PVN8-04JD-YGSE-KA6Q` (150 Bit Zufall + Prüfsumme).
2. **Code weitergeben.** Auf Papier, persönlich oder per Messenger, wie du willst.
3. **Anklopfen & bestätigen.** Wer den Code eingibt, klopft an. Du als Initiator nimmst die Person aktiv auf. Erst dann bekommt sie den Raumschlüssel.
4. **Chatten.** Texte, Bilder, Videos, Dateien und Sprachnachrichten, alles Ende-zu-Ende verschlüsselt und signiert.

Optional schützt ein **Passwort**, ein **Zweitschlüssel** oder **drei Sicherheitsfragen** den Raum zusätzlich.

## Kryptografie

| Zweck | Verfahren |
|---|---|
| Schlüsselzustellung | HPKE (RFC 9180), **ML-KEM-768 + X25519** hybrid, HKDF-SHA256, ChaCha20-Poly1305 |
| Absender-Signaturen | **ML-DSA-65** (FIPS 204) |
| Nachrichten & Medien | **XChaCha20-Poly1305**, 256-Bit-Schlüssel, Längen-Padding |
| Code / Passwort / Antworten | **Argon2id** (64 MiB, t=3) → HKDF-SHA256 |

Die gesamte Kryptografie ist Go-Standardbibliothek (`crypto/mlkem`, `crypto/mldsa`, `crypto/hpke`) plus `x/crypto`. Sie läuft im Browser als WebAssembly in einem Web Worker. Es gibt keine handgeschriebene Krypto in JavaScript.

Details: [docs/PROTOCOL.md](docs/PROTOCOL.md) · Bedrohungsmodell: [SECURITY.md](SECURITY.md)

## Was der Server sieht

Das Relay ist **blind**. Es kennt nur eine aus dem Code abgeleitete Raum-ID (Hash) und leitet verschlüsselte Pakete weiter. Codes, Namen, Raumnamen, Inhalte und Schlüssel sieht es nie. Es schreibt nichts auf die Festplatte und loggt keine IP-Adressen. Verschlüsselte Nachrichten für Offline-Mitglieder hält es höchstens 72 Stunden im RAM (konfigurierbar, abschaltbar).

Der Verlauf liegt **redundant und verschlüsselt** bei allen Mitgliedern (IndexedDB). Fehlende Nachrichten und Medien liefern andere Mitglieder Peer-to-Peer nach. Lesbar ist der Verlauf nur mit dem Code (und ggf. Passwort/Antworten).

## Installation

### Docker

```sh
docker run -d --name nullraum -p 8080:8080 --read-only ghcr.io/maliceatthepalace/nullraum:latest
```

Mit automatischem HTTPS (Caddy). HTTPS ist für Sprachnachrichten nötig und für den Betrieb im Internet dringend empfohlen:

```sh
git clone https://github.com/maliceatthepalace/nullraum && cd nullraum
NULLRAUM_DOMAIN=chat.example.org docker compose up -d
```

### Linux / macOS / Windows

Binaries gibt es unter [Releases](https://github.com/maliceatthepalace/nullraum/releases):

```sh
./nullraum serve -addr :8080          # Relay + Web-App
./nullraum serve -self-signed         # HTTPS im LAN mit selbstsigniertem Zertifikat
./nullraum client -relay https://chat.example.org   # App lokal ausliefern, nur Relay entfernt
./nullraum                            # Doppelklick: lokales Relay + Browser öffnen
```

**`client`-Modus:** Die App (und damit der Code, der deine Schlüssel verarbeitet) kommt von deinem eigenen Rechner, nicht vom Relay-Betreiber. Das ist der sicherste Weg, einen fremden Server zu nutzen.

### Aus dem Quellcode

Benötigt Go ≥ 1.26 (für `crypto/mldsa` und `crypto/hpke`):

```sh
make          # baut web/app/nullraum.wasm + bin/nullraum
make test
make release  # Binaries für alle Plattformen nach dist/
```

### Optionen (`nullraum serve -h`)

| Flag | Standard | |
|---|---|---|
| `-addr` | `:8080` | Listen-Adresse (`NULLRAUM_ADDR`) |
| `-tls-cert`, `-tls-key` | | eigenes Zertifikat |
| `-self-signed` | aus | selbstsigniertes TLS-Zertifikat |
| `-mailbox-ttl` | `72h` | RAM-Zwischenspeicher für Offline-Mitglieder, `0` = aus |
| `-mailbox-room-mb` / `-mailbox-total-mb` | 256 / 1024 | RAM-Limits |
| `-max-peers` | 64 | Verbindungen pro Raum |
| `-trust-proxy` | aus | `X-Forwarded-For` hinter Reverse-Proxy |

## Projektstruktur

```
cmd/nullraum      CLI: serve / client
cmd/wasm          Go → WebAssembly Brücke für den Browser
internal/pqc      Kryptografie (Code-Format, Argon2id, HPKE, ML-DSA, AEAD, Padding)
internal/relay    Blindes WebSocket-Relay mit RAM-Mailbox
web/app           Chat-App (Vanilla JS, keine Abhängigkeiten, strikte CSP)
web/site          Website (wird auch auf GitHub Pages veröffentlicht)
test/e2e          Browser-Ende-zu-Ende-Test mit drei Nutzern (Playwright)
```

## Status

Nullraum ist neu und **nicht unabhängig auditiert**. Die verwendeten Verfahren sind standardisiert, das Protokoll selbst ist es nicht. Reviews und Issues sind sehr willkommen.

Lizenz: MIT
