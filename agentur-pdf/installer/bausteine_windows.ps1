# Kopiert Tesseract, die besten deutschen Erkennungsmodelle, LibreOffice und
# die Anleitung neben die gebaute Agentur-PDF.exe.
param(
  [string]$Ziel = "dist\Agentur-PDF",
  [string]$Tessdata = "..\..\tessdata_best",
  [string]$Hunspell = "..\..\hunspell"
)
$ErrorActionPreference = "Stop"

Write-Host "Tesseract …"
Copy-Item "C:\Program Files\Tesseract-OCR" "$Ziel\tesseract" -Recurse -Force
# mitgelieferte (Standard-)Modelle entfernen – wir nutzen tessdata_best
Remove-Item "$Ziel\tesseract\tessdata\*.traineddata" -ErrorAction SilentlyContinue

Write-Host "Erkennungsmodelle (tessdata_best) …"
New-Item -ItemType Directory -Force "$Ziel\tessdata" | Out-Null
Copy-Item "$Tessdata\*.traineddata" "$Ziel\tessdata\" -Force

Write-Host "Wörterbuch (Hunspell de_DE) …"
New-Item -ItemType Directory -Force "$Ziel\hunspell" | Out-Null
Copy-Item "$Hunspell\de_DE.*" "$Ziel\hunspell\" -Force

Write-Host "LibreOffice …"
Copy-Item "C:\Program Files\LibreOffice" "$Ziel\libreoffice" -Recurse -Force
# Hilfe und Beispielvorlagen werden nicht gebraucht (spart Platz)
Remove-Item "$Ziel\libreoffice\help" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$Ziel\libreoffice\share\template" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$Ziel\libreoffice\share\gallery" -Recurse -Force -ErrorAction SilentlyContinue

Copy-Item "LIESMICH.txt" "$Ziel\LIESMICH.txt" -Force
Write-Host "Fertig: $Ziel"
