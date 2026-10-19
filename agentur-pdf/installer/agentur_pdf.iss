; Setup für Agentur-PDF (Inno Setup 6)
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
AppName=Agentur-PDF
AppVersion={#AppVersion}
AppVerName=Agentur-PDF {#AppVersion}
AppPublisher=Agentur
VersionInfoVersion={#NumVersion}
VersionInfoDescription=Agentur-PDF Setup
DefaultDirName={localappdata}\Programs\Agentur-PDF
DefaultGroupName=Agentur-PDF
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
UninstallDisplayName=Agentur-PDF
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
Name: "explorer"; Description: "Explorer-Rechtsklick („Mit Agentur-PDF öffnen“, „Zu einer PDF zusammenführen“) und „Öffnen mit“ einrichten"
Name: "chrome"; Description: "Google Chrome: Agentur-PDF-Seitenleiste einrichten (öffnet danach Chrome mit kurzer Anleitung)"
Name: "drucker"; Description: "PDF-Drucker „Agentur-PDF“ einrichten (fragt nach Administratorrechten)"; Flags: unchecked

[InstallDelete]
; alte Programmdateien entfernen – sonst bleiben bei Updates Reste liegen
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "dist\Agentur-PDF\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
; Link „agentur-pdf://start“ – damit die Chrome-Seitenleiste das Programm starten kann
Root: HKCU; Subkey: "Software\Classes\agentur-pdf"; ValueType: string; ValueName: ""; ValueData: "URL:Agentur-PDF"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\agentur-pdf"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\agentur-pdf\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\Agentur-PDF.exe,0"
Root: HKCU; Subkey: "Software\Classes\agentur-pdf\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Agentur-PDF.exe"" ""%1"""

[Icons]
Name: "{autoprograms}\Agentur-PDF"; Filename: "{app}\Agentur-PDF.exe"
Name: "{autodesktop}\Agentur-PDF"; Filename: "{app}\Agentur-PDF.exe"; Tasks: desktop

[Run]
Filename: "{app}\Agentur-PDF.exe"; Parameters: "--explorer-einrichten"; StatusMsg: "Explorer-Einträge werden eingerichtet …"; Flags: runhidden waituntilterminated; Tasks: explorer
Filename: "{app}\Agentur-PDF.exe"; Parameters: "--drucker-einrichten"; StatusMsg: "PDF-Drucker wird eingerichtet …"; Verb: "runas"; Flags: shellexec runhidden waituntilterminated; Tasks: drucker; Check: not NachUpdateStarten
Filename: "{app}\Agentur-PDF.exe"; Parameters: "--chrome-einrichten"; Flags: nowait; Tasks: chrome; Check: not NachUpdateStarten
Filename: "{app}\Agentur-PDF.exe"; Description: "Agentur-PDF jetzt starten"; Flags: nowait postinstall skipifsilent
Filename: "{app}\Agentur-PDF.exe"; Parameters: "--nach-update"; Flags: nowait; Check: NachUpdateStarten

[UninstallRun]
Filename: "{app}\Agentur-PDF.exe"; Parameters: "--explorer-entfernen"; Flags: runhidden waituntilterminated; RunOnceId: "ExplorerEntfernen"

[Code]
function NachUpdateStarten: Boolean;
begin
  Result := ExpandConstant('{param:NEUSTART|0}') = '1';
end;
