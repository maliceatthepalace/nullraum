# Nullraum-Protokoll v1

Implementierung: `internal/pqc` (Primitive) und `web/app/room.js` (Protokoll).

## Raumcode

* 30 Symbole aus Crockford-Base32 (`0-9A-Z` ohne `I L O U`) = 150 Bit aus `crypto/rand`
* plus 2 Prüfsymbole = die ersten 10 Bit von `SHA-256("nullraum/v1/code-check/" ‖ daten)`
* Darstellung: 8 Blöcke à 4 Zeichen. Bei der Eingabe werden `O→0`, `I/L→1`, `U→V` gemappt und Trennzeichen ignoriert.

## Ableitungen

```
master    = Argon2id(code, salt="nullraum/v1/room-code", t=3, m=64 MiB, p=1, 32 B)
roomId    = HKDF(master, "room-id")        → an das Relay (hex)
joinKey   = HKDF(master, "join")
hdrKey    = HKDF(master, "vault-header")

secret    = Argon2id(geheimnis, "nullraum/v1/secret/" ‖ salt16)    (optional)
            geheimnis = Passwort | normalisierter Zweitschlüssel | normalize(a1) ␟ normalize(a2) ␟ normalize(a3)
joinReq   = HKDF(joinKey ‖ secret, "join-request")
vaultKey  = HKDF(master ‖ secret, "vault")
```

HKDF = HKDF-SHA256 mit Salt `"nullraum/v1"`.

## Identitäten

Jedes Gerät erzeugt **pro Raum** neue Schlüssel, sodass Räume nicht verknüpfbar sind:

* KEM-Paar: HPKE `MLKEM768X25519` (hybrid)
* Signaturpaar: ML-DSA-65
* `memberId = hex(SHA-256(sigPub))[0:16]`

## Pakete

Relay-Frame: `{"t":"send","to"?:peer,"store"?:bool,"d":{k,e?,c}}`

| k | Verschlüsselung | Inhalte |
|---|---|---|
| `j` | XChaCha20-Poly1305(joinKey), AAD `j|roomId` | hello, challenge, deny, rekey |
| `q` | XChaCha20-Poly1305(joinReq), AAD `q|roomId` | joinreq |
| `w` | HPKE(kemPub des Beitretenden, info `welcome|roomId`) ∘ XChaCha20-Poly1305(joinReq) | welcome |
| `r` | XChaCha20-Poly1305(roomKey[e]), AAD `r|roomId|e` | msg, chunk, roster, sync_req/resp, media_req, leave, close |

Alle Klartexte werden vor der Verschlüsselung auf Zweierpotenzen (min. 256 B) bzw. 64-KiB-Vielfache aufgefüllt.
Signaturen nutzen ML-DSA-Kontexte `nullraum/v1/<zweck>|roomId`.

## Beitritt

```
Beitretender                         Initiator (admin)
  hello{nonce}            ──j──▶     (broadcast)
                          ◀──j──     challenge{nonce, anonce, adminSig, protection}  signiert (admin)
  [Passwort/Antworten → secret]
  joinreq{name,kem,sig,anonce} ─q──▶ entschlüsselt? sonst deny{secret}, max. 3 Versuche pro Verbindung
                                     UI: Name + Sicherheitsnummer = FP(adminSig, sigPub, kemPub)
                                     „Aufnehmen“ → (wenn Verlauf gesperrt: Rekey) → Roster v+1
                          ◀──w──     welcome{keys, epoch, roster(signiert)}
```

* Antworten zwei verschiedene `adminSig` auf dasselbe hello, bricht der Client ab (Imitationsversuch durch einen anderen Code-Inhaber).
* Die Sicherheitsnummer (24 Ziffern, ca. 80 Bit) kann out-of-band verglichen werden. Danach ist ein MitM ausgeschlossen.
* Das Welcome ist doppelt geschützt: Zum Öffnen braucht man den privaten PQ-Schlüssel **und** Code+Geheimnis.

## Roster & Schlüssel

* Das Roster `{version, roomName, history, members{id:{name,kem,sig,admin,since,removed?,removedAt?}}}` wird vom Initiator mit ML-DSA signiert und nur mit höherer Version akzeptiert.
* **Rekey:** neuer 256-Bit-Raumschlüssel, für jedes verbleibende Mitglied einzeln per HPKE (ML-KEM-768+X25519) versiegelt, als signiertes `rekey` im `j`-Layer verteilt und in der Relay-Mailbox abgelegt.
* Rekey erfolgt bei Rauswurf, bei Austritt, vor jeder Aufnahme (wenn neue Mitglieder den Verlauf nicht sehen dürfen) und manuell.
* Entfernte Mitglieder: Nachrichten mit `ts ≥ removedAt` werden verworfen.

## Nachrichten

```
env = {v, id(128 Bit), from, ts, kind: text|image|video|audio|file, text?, media?}
packet = {type:"msg", env: b64(json(env)), sig: ML-DSA-65(env)}
```

Medien: eigener zufälliger 256-Bit-Schlüssel, `ct = XChaCha20-Poly1305(fileKey, datei, AAD media|mid)`. In `env.media` stehen `mid`, `mime`, `size`, `key` und `hash = SHA-256(ct)`. Der Chiffretext geht in Chunks à 192 KiB als `chunk`-Pakete raus. Fotos werden vor dem Senden neu kodiert, damit EXIF/GPS entfernt wird.

## Redundanz

* Jedes Mitglied speichert alle Envelopes (mit Signatur) verschlüsselt mit `vaultKey` in IndexedDB, Medien als Chiffretext.
* Beim Verbinden: `sync_req{member, epoch, have[≤300 ids]}`. Andere Mitglieder antworten gezielt mit fehlenden Envelopes (nur `ts ≥ since` des Anfragenden), dem aktuellen Roster und, falls die Epoche veraltet ist, dem letzten Rekey.
* Fehlende Medien: `media_req{mid}` → jedes Mitglied mit der Datei sendet die Chunks gezielt.
* Signaturen machen weitergereichte Nachrichten fälschungssicher, egal wer sie liefert.

## Lokaler Tresor

`vaults[roomId] = {h: seal(hdrKey, {protection}), b: seal(vaultKey, {identität, schlüssel, roster, …})}`. Der Code selbst wird nie gespeichert.
