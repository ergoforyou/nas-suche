; Setup für Ergo4You PDF (intern „Agentur-PDF“: Ordner, .exe, Setup-Dateiname bleiben gleich,
; damit Updates und vorhandene Einträge weiter passen) – Inno Setup 6
;
; * Installation pro Benutzer nach %LOCALAPPDATA%\Programs\Agentur-PDF –
;   keine Administratorrechte nötig, Updates laufen ohne Rückfrage.
; * Startmenü, optional Desktop-Verknüpfung, Explorer-Rechtsklick und
;   „Öffnen mit“/Standard-Programm-Kandidat für PDF.
; * Stille Aktualisierung (aus dem Programm heraus):
;     Agentur-PDF-Setup-x.y.z.exe /SILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS /NEUSTART=1
;
; Bauen: iscc /DAppVersion=0.7.0-test /DNumVersion=0.7.0 agentur_pdf.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef NumVersion
  #define NumVersion "0.0.0"
#endif

[Setup]
AppId={{8C5D1A3E-2B7F-4E61-9A0C-3F4D5E6A7B81}
AppName=Ergo4You PDF
AppVersion={#AppVersion}
AppVerName=Ergo4You PDF {#AppVersion} (Beta MK I)
AppPublisher=Ergo4You
VersionInfoVersion={#NumVersion}
VersionInfoDescription=Ergo4You PDF Setup
DefaultDirName={localappdata}\Programs\Agentur-PDF
DefaultGroupName=Ergo4You PDF
DisableProgramGroupPage=yes
DisableDirPage=auto
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=dist
OutputBaseFilename=Agentur-PDF-Setup-{#AppVersion}
SetupIconFile=agentur-pdf.ico
UninstallDisplayIcon={app}\Agentur-PDF.exe
UninstallDisplayName=Ergo4You PDF
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
RestartApplications=no
ShowLanguageDialog=no

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"

[Tasks]
Name: "desktop"; Description: "Verknüpfung auf dem Desktop anlegen"
Name: "explorer"; Description: "Explorer-Rechtsklick („Mit Ergo4You PDF öffnen“, „Zu einer PDF zusammenführen“) und „Öffnen mit“ einrichten"
Name: "chrome"; Description: "Google Chrome: PDFs in Chrome mit Ergo4You PDF öffnen (öffnet danach Chrome mit kurzer Anleitung)"
Name: "drucker"; Description: "PDF-Drucker „Ergo4You PDF“ einrichten (fragt nach Administratorrechten)"; Flags: unchecked

[InstallDelete]
; alte Programmdateien entfernen – sonst bleiben bei Updates Reste liegen
Type: filesandordirs; Name: "{app}\_internal"
; Verknüpfungen mit dem früheren Namen
Type: files; Name: "{autoprograms}\Agentur-PDF.lnk"
Type: files; Name: "{autodesktop}\Agentur-PDF.lnk"

[Files]
Source: "dist\Agentur-PDF\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
; Link „agentur-pdf://start“ – damit die Chrome-Seitenleiste das Programm starten kann
Root: HKCU; Subkey: "Software\Classes\agentur-pdf"; ValueType: string; ValueName: ""; ValueData: "URL:Ergo4You PDF"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\agentur-pdf"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\agentur-pdf\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\Agentur-PDF.exe,0"
Root: HKCU; Subkey: "Software\Classes\agentur-pdf\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Agentur-PDF.exe"" ""%1"""

[Icons]
Name: "{autoprograms}\Ergo4You PDF"; Filename: "{app}\Agentur-PDF.exe"
Name: "{autodesktop}\Ergo4You PDF"; Filename: "{app}\Agentur-PDF.exe"; Tasks: desktop

[Run]
Filename: "{app}\Agentur-PDF.exe"; Parameters: "--explorer-einrichten"; StatusMsg: "Explorer-Einträge werden eingerichtet …"; Flags: runhidden waituntilterminated; Tasks: explorer
Filename: "{app}\Agentur-PDF.exe"; Parameters: "--drucker-einrichten"; StatusMsg: "PDF-Drucker wird eingerichtet …"; Verb: "runas"; Flags: shellexec runhidden waituntilterminated; Tasks: drucker; Check: not NachUpdateStarten
Filename: "{app}\Agentur-PDF.exe"; Parameters: "--chrome-einrichten"; Flags: nowait; Tasks: chrome; Check: not NachUpdateStarten
Filename: "{app}\Agentur-PDF.exe"; Description: "Ergo4You PDF jetzt starten"; Flags: nowait postinstall skipifsilent
Filename: "{app}\Agentur-PDF.exe"; Parameters: "--nach-update"; Flags: nowait; Check: NachUpdateStarten

[UninstallRun]
Filename: "{app}\Agentur-PDF.exe"; Parameters: "--explorer-entfernen"; Flags: runhidden waituntilterminated; RunOnceId: "ExplorerEntfernen"

[Code]
function NachUpdateStarten: Boolean;
begin
  Result := ExpandConstant('{param:NEUSTART|0}') = '1';
end;
