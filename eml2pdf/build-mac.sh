#!/bin/sh
# Baut dist/EML-zu-PDF-Mac.zip mit "EML zu PDF.app" (Apple-Chip + Intel in einer Datei).
# Geht unter Linux/macOS. Benötigt:
#   makefat   : go install github.com/randall77/makefat@latest
#   rcodesign : cargo install --locked apple-codesign   (Ad-hoc-Signatur, ohne Apple-Konto)
set -e
cd "$(dirname "$0")"
VERSION=$(sed -n 's/^[[:space:]]*version = "\(.*\)"/\1/p' main.go)
APP="build/EML zu PDF.app"
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" dist

for arch in arm64 amd64; do
	GOOS=darwin GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o build/eml2pdf-$arch .
done
${MAKEFAT:-makefat} "$APP/Contents/MacOS/eml2pdf" build/eml2pdf-arm64 build/eml2pdf-amd64
chmod 755 "$APP/Contents/MacOS/eml2pdf"
cp macres/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>de</string>
	<key>CFBundleExecutable</key>
	<string>eml2pdf</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundleIdentifier</key>
	<string>de.ergoforyou.eml-zu-pdf</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>EML zu PDF</string>
	<key>CFBundleDisplayName</key>
	<string>EML zu PDF</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$VERSION</string>
	<key>CFBundleVersion</key>
	<string>$VERSION</string>
	<key>LSMinimumSystemVersion</key>
	<string>12.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSHumanReadableCopyright</key>
	<string>ergoforyou</string>
	<key>NSDownloadsFolderUsageDescription</key>
	<string>Damit neu heruntergeladene E-Mails (.eml) automatisch in PDF umgewandelt werden.</string>
	<key>NSDocumentsFolderUsageDescription</key>
	<string>Damit die fertigen PDFs im gewählten Zielordner gespeichert werden können.</string>
	<key>NSDesktopFolderUsageDescription</key>
	<string>Damit E-Mails vom Schreibtisch umgewandelt werden können.</string>
</dict>
</plist>
PLIST

${RCODESIGN:-rcodesign} sign "$APP"
rm -f dist/EML-zu-PDF-Mac.zip
(cd build && zip -qry ../dist/EML-zu-PDF-Mac.zip "EML zu PDF.app")
rm -f build/eml2pdf-arm64 build/eml2pdf-amd64
ls -l dist/EML-zu-PDF-Mac.zip
