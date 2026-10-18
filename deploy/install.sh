#!/bin/sh
# Nullraum-Relay mit einem Befehl einrichten (Linux-Server mit öffentlicher IP).
#
#   curl -fsSL https://raw.githubusercontent.com/maliceatthepalace/nullraum/main/deploy/install.sh | sudo sh
#
# Eigene Domain statt IP:
#   curl -fsSL …/install.sh | sudo NULLRAUM_DOMAIN=chat.example.org sh
#
# Ohne eigene Domain wird <ip>.sslip.io verwendet: Dieser Name zeigt automatisch
# auf deine IP, damit es ein echtes HTTPS-Zertifikat (Let's Encrypt) gibt.
set -eu

DIR=/opt/nullraum
REPO=https://github.com/maliceatthepalace/nullraum

if [ "$(id -u)" != 0 ]; then
  echo "Bitte mit sudo ausführen: curl -fsSL … | sudo sh" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "→ Docker wird installiert …"
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null 2>&1 || { echo "→ git wird installiert …"; (apt-get install -y git || dnf install -y git || apk add git) >/dev/null; }

if [ -d "$DIR/.git" ]; then
  echo "→ Nullraum wird aktualisiert …"
  git -C "$DIR" pull -q
else
  echo "→ Nullraum wird heruntergeladen …"
  git clone -q "$REPO" "$DIR"
fi

DOMAIN="${NULLRAUM_DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  IP="$(curl -4fsS https://api.ipify.org || true)"
  if [ -z "$IP" ]; then
    echo "Öffentliche IP nicht gefunden. Bitte NULLRAUM_DOMAIN=… angeben." >&2
    exit 1
  fi
  DOMAIN="$(echo "$IP" | tr . -).sslip.io"
fi
echo "NULLRAUM_DOMAIN=$DOMAIN" > "$DIR/.env"

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q active; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
fi

echo "→ Server wird gestartet …"
cd "$DIR"
docker compose pull -q
docker compose up -d

echo "→ Warte auf das HTTPS-Zertifikat …"
i=0
until curl -fsS -o /dev/null "https://$DOMAIN/healthz" 2>/dev/null; do
  i=$((i + 1))
  if [ $i -gt 30 ]; then
    echo
    echo "HTTPS antwortet noch nicht. Sind Port 80 und 443 beim Hoster/Router offen?"
    echo "Log ansehen: cd $DIR && docker compose logs caddy"
    exit 1
  fi
  sleep 3
done

echo
echo "✓ Fertig! Diesen Link an alle schicken:"
echo
echo "    https://$DOMAIN/app/"
echo
echo "Update später:  curl -fsSL $REPO/raw/main/deploy/install.sh | sudo sh"
