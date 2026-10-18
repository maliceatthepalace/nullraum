# Browser-Ende-zu-Ende-Test

Spielt drei Personen (Alice, Bob, Carol) in getrennten Browser-Kontexten durch: Raum mit Passwort erstellen, falsches Passwort, Sicherheitsnummern vergleichen, Aufnahme, Text, Bild, 900-KB-Datei (mehrere Chunks), gesperrter Verlauf für Neue, Rauswurf mit Rekey, lokales Entsperren und Offline-Zustellung.

```sh
./bin/nullraum serve -addr 127.0.0.1:8080 &
mkdir -p test/e2e/shots
docker run --rm --network host -v "$PWD/test/e2e":/work -w /work \
  mcr.microsoft.com/playwright:v1.64.1-noble bash -c "npm i --silent && node e2e.mjs"
```
