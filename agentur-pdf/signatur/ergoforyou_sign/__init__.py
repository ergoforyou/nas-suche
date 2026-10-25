"""Ergoforyou Sign – Dokumente per Link online unterschreiben lassen.

Läuft als Container auf dem Synology-NAS (DS1517+). Zwei Ports:

* 8480 – Kundenseite (nur ``/s/<link>``), wird über den DSM-Reverse-Proxy mit
  HTTPS ins Internet gegeben.
* 8481 – intern: Einrichtung im Browser und Schnittstelle für Ergoforyou PDF.
  Dieser Port wird am Router NICHT freigegeben.
"""

__version__ = "0.4.0"
PRODUKT = "Ergoforyou Sign"
