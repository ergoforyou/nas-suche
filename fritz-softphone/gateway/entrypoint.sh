#!/bin/sh
set -e

fail() { echo "FEHLER: $1" >&2; exit 1; }

[ -n "$FRITZBOX_HOST" ]     || fail "FRITZBOX_HOST fehlt (z.B. 192.168.178.1)"
[ -n "$FRITZ_SIP_USER" ]    || fail "FRITZ_SIP_USER fehlt (Benutzername des IP-Telefons in der FRITZ!Box)"
[ -n "$FRITZ_SIP_PASSWORD" ] || fail "FRITZ_SIP_PASSWORD fehlt"
[ -n "$WEBPHONE_PASSWORD" ] || fail "WEBPHONE_PASSWORD fehlt (Passwort, mit dem sich die Chrome-Erweiterung anmeldet)"

export WEBPHONE_USER="${WEBPHONE_USER:-webphone}"
export HTTP_PORT="${HTTP_PORT:-8088}"
export SIP_PORT="${SIP_PORT:-5070}"
export RTP_START="${RTP_START:-10000}"
export RTP_END="${RTP_END:-10200}"

# Nur unsere Variablen ersetzen – ${EXTEN} usw. im Dialplan bleiben stehen.
VARS='${FRITZBOX_HOST} ${FRITZ_SIP_USER} ${FRITZ_SIP_PASSWORD} ${WEBPHONE_USER} ${WEBPHONE_PASSWORD} ${HTTP_PORT} ${SIP_PORT} ${RTP_START} ${RTP_END}'
for f in /etc/asterisk-templates/*.conf; do
  envsubst "$VARS" < "$f" > "/etc/asterisk/$(basename "$f")"
done
chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk /var/run/asterisk 2>/dev/null || true

echo "Gateway startet: WebSocket ws://<NAS-IP>:${HTTP_PORT}/ws  ->  FRITZ!Box ${FRITZBOX_HOST} (Benutzer ${FRITZ_SIP_USER})"
exec asterisk -f -U asterisk -G asterisk -vvv
