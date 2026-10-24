# Ergoforyou Sign – Container für die Synology DS1517+ (Container Manager)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    SIGN_DATEN=/daten \
    TZ=Europe/Berlin

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY ergoforyou_sign ./ergoforyou_sign

EXPOSE 8480 8481
VOLUME ["/daten"]
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8480/gesundheit', timeout=4)"

CMD ["python", "-m", "ergoforyou_sign"]
