# Installiert "EML zu PDF" für den aktuellen Benutzer (keine Admin-Rechte nötig):
#  - Rechtsklick auf .eml  ->  "In PDF umwandeln"
#  - "Senden an"  ->  "EML in PDF umwandeln" (auch für mehrere Dateien gleichzeitig)
#  - Automatik: überwacht den Downloads-Ordner ab Windows-Anmeldung
$ErrorActionPreference = "Stop"

function Find-Python {
    foreach ($cmd in @("py", "python")) {
        try {
            $exe = & $cmd -c "import sys; print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path $exe)) { return $exe.Trim() }
        } catch { }
    }
    return $null
}

$python = Find-Python
if (-not $python) {
    Write-Host "Python wurde nicht gefunden." -ForegroundColor Red
    Write-Host "Bitte Python von https://www.python.org/downloads/ installieren"
    Write-Host "(beim Installieren 'Add python.exe to PATH' anhaken) und dann erneut starten."
    Read-Host "Enter zum Beenden"
    exit 1
}
$pythonw = Join-Path (Split-Path $python) "pythonw.exe"
if (-not (Test-Path $pythonw)) { $pythonw = $python }
Write-Host "Python gefunden: $python"

Write-Host "Installiere benötigte Pakete (Pillow, pywin32) ..."
& $python -m pip install --user --upgrade --quiet pillow pywin32
if ($LASTEXITCODE -ne 0) { throw "pip install ist fehlgeschlagen." }

# Programm nach %LOCALAPPDATA%\eml2pdf kopieren
$target = Join-Path $env:LOCALAPPDATA "eml2pdf"
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot "eml2pdf.py") $target
$script = Join-Path $target "eml2pdf.py"

# Laufende Überwachung beenden (falls schon einmal installiert)
Get-CimInstance Win32_Process -Filter "Name like 'python%'" |
    Where-Object { $_.CommandLine -like "*eml2pdf.py*--ueberwachen*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# 1) Rechtsklick-Menü für .eml-Dateien
$key = "HKCU:\Software\Classes\SystemFileAssociations\.eml\shell\eml2pdf"
New-Item -Force -Path "$key\command" | Out-Null
Set-ItemProperty -Path $key -Name "MUIVerb" -Value "In PDF umwandeln"
Set-ItemProperty -Path $key -Name "Icon" -Value "imageres.dll,-102"
Set-Item -Path "$key\command" -Value "`"$pythonw`" `"$script`" `"%1`""

$shell = New-Object -ComObject WScript.Shell

# 2) "Senden an"-Eintrag (praktisch für mehrere Dateien auf einmal)
$sendTo = [Environment]::GetFolderPath("SendTo")
$lnk = $shell.CreateShortcut((Join-Path $sendTo "EML in PDF umwandeln.lnk"))
$lnk.TargetPath = $pythonw
$lnk.Arguments = "`"$script`""
$lnk.IconLocation = "imageres.dll,102"
$lnk.Save()

# 3) Automatik: Downloads-Ordner beim Windows-Start überwachen
$startup = [Environment]::GetFolderPath("Startup")
$lnk = $shell.CreateShortcut((Join-Path $startup "EML zu PDF Automatik.lnk"))
$lnk.TargetPath = $pythonw
$lnk.Arguments = "`"$script`" --ueberwachen"
$lnk.WorkingDirectory = $target
$lnk.Save()

Start-Process -FilePath $pythonw -ArgumentList "`"$script`" --ueberwachen" -WorkingDirectory $target -WindowStyle Hidden

Write-Host ""
Write-Host "Fertig!" -ForegroundColor Green
Write-Host " - Neue .eml-Dateien im Downloads-Ordner werden ab jetzt automatisch umgewandelt."
Write-Host " - Rechtsklick auf eine .eml -> 'In PDF umwandeln'"
Write-Host "   (Windows 11: zuerst 'Weitere Optionen anzeigen')."
Write-Host " - Mehrere Dateien: markieren -> Rechtsklick -> 'Senden an' -> 'EML in PDF umwandeln'"
Write-Host " - Protokoll: $target\eml2pdf.log"
Read-Host "Enter zum Beenden"
