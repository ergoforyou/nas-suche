# Kleines SIP-Gateway: Browser (WebRTC/WebSocket) <-> FRITZ!Box (SIP/UDP)
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends asterisk asterisk-moh-opsound-gsm gettext-base ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/asterisk/*

COPY config/ /etc/asterisk-templates/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

HEALTHCHECK --interval=60s --timeout=10s \
  CMD asterisk -rx "pjsip show registrations" | grep -q Registered || exit 1

ENTRYPOINT ["/entrypoint.sh"]
