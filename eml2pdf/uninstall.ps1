# Entfernt "EML zu PDF" wieder (bereits erzeugte PDFs bleiben erhalten).
$ErrorActionPreference = "SilentlyContinue"

Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
    Where-Object { $_.CommandLine -like "*eml2pdf.py*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Remove-Item -Recurse -Force "HKCU:\Software\Classes\SystemFileAssociations\.eml\shell\eml2pdf"
Remove-Item -Force (Join-Path ([Environment]::GetFolderPath("SendTo")) "EML in PDF umwandeln.lnk")
Remove-Item -Force (Join-Path ([Environment]::GetFolderPath("Startup")) "EML zu PDF Automatik.lnk")
Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA "eml2pdf")

Write-Host "EML zu PDF wurde entfernt." -ForegroundColor Green
Read-Host "Enter zum Beenden"
