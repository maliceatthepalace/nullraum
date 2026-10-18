# Sicherheit & Bedrohungsmodell

## Schutzziele

| Angreifer | Ergebnis |
|---|---|
| Relay-Betreiber / kompromittierter Server | sieht keine Inhalte, Namen, Codes oder Schlüssel, kann nichts fälschen. Sieht Raum-ID-Hash, Verbindungszahl, Zeitpunkte, gepolsterte Größen, IP-Adressen. |
| Netzwerk-Mitschnitt heute, Quantencomputer später | Schlüsselzustellung via ML-KEM-768 + X25519, Inhalte mit 256-Bit-Symmetrie, also geschützt. |
| Jemand findet den Code | kann nur anklopfen. Ohne Bestätigung durch den Initiator gibt es keinen Raumschlüssel. Mit Zusatzschutz scheitert er schon vorher (max. 3 Versuche pro Verbindung). |
| Code-Inhaber gibt sich als Initiator aus | Konflikt wird erkannt (zwei Admin-Schlüssel). Die Sicherheitsnummer deckt einen MitM beim Vergleich auf. |
| Entferntes Mitglied | bekommt den nächsten Raumschlüssel nicht, spätere Nachrichten von ihm werden verworfen. |
| Neues Mitglied (Verlauf gesperrt) | bekommt nur den aktuellen Schlüssel, Peers liefern keinen älteren Verlauf. |
| Gestohlenes Gerät ohne Code | lokale Daten sind mit Argon2id(Code[+Geheimnis]) verschlüsselt. |

## Nicht abgedeckt

* **Kompromittierte Endgeräte**, Screenshots, Schadsoftware, Browser-Erweiterungen mit Seitenzugriff.
* **Vertrauen in ausgelieferten Code.** Wer die App von einem fremden Server lädt, vertraut diesem Server. Sicherer ist `nullraum client -relay …` oder ein eigenes Relay.
* **Metadaten** wie Zeitpunkte, Paketgrößen (gepolstert) und IP-Adressen. Gegen Verkehrsanalyse helfen Tor oder VPN.
* **Forward Secrecy pro Nachricht.** Schlüssel wechseln pro Epoche, nicht pro Nachricht. Wer einen Raumschlüssel einer Epoche erbeutet, liest diese Epoche.
* **Mitglieder untereinander:** Jedes Mitglied kann alles lesen, was im Raum geschrieben wird. Signaturen verhindern aber, dass jemand im Namen anderer schreibt.
* **Videos/Dateien** werden nicht von Metadaten befreit, nur Fotos.
* Kein unabhängiges Audit.

## Härtung des Servers

* Keine Festplattenzugriffe, keine Request-Logs, kein IP-Logging
* Docker: `scratch`-Image, non-root, `read_only`, `cap_drop: ALL`
* Strikte CSP (keine Inline-Skripte, keine Fremdquellen), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, COOP/CORP
* Limits: Frame-Größe, Frames/s, Verbindungen pro IP und Raum, RAM-Budget der Mailbox

## Lücken melden

Bitte nicht öffentlich als Issue, sondern über „Report a vulnerability“ (GitHub Security Advisories) in diesem Repository.
