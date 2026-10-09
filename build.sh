#!/bin/sh
# Baut NasSuche.exe (Windows 10/11, 64 Bit) – auch von Linux aus.
set -e
cd "$(dirname "$0")"
go run github.com/tc-hib/go-winres@v0.3.3 simply --arch amd64 --manifest gui --icon icon.png \
  --product-name "NAS-Suche" --file-description "NAS-Suche – schnelle Dateisuche" \
  --product-version 1.0.0 --file-version 1.0.0 --original-filename NasSuche.exe
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w" -o NasSuche.exe .
echo "Fertig: NasSuche.exe"
