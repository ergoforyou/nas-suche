#!/bin/sh
# Baut die Windows-Programmdatei dist/EML-zu-PDF.exe (geht auch unter Linux/macOS).
# Symbol/Versionsinfo neu erzeugen (nur nötig, wenn sich winres/icon.png oder die Version ändert):
#   cd winres && go run github.com/tc-hib/go-winres@latest simply --icon icon.png --manifest gui \
#     --product-name "EML zu PDF" --product-version 1.0.0 --file-version 1.0.0 --out ../rsrc && rm ../rsrc_windows_386.syso
set -e
cd "$(dirname "$0")"
mkdir -p dist
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H windowsgui" -o dist/EML-zu-PDF.exe .
ls -l dist/EML-zu-PDF.exe
