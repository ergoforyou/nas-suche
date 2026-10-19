; Inno-Setup-Skript: erzeugt DiktierFlow-Setup.exe
; Installiert ohne Administratorrechte nach %LOCALAPPDATA%\Programs\DiktierFlow

#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif

[Setup]
AppId={{6F3B2C1E-8D4A-4E5B-9C7D-5A1F0D1E7F01}
AppName=DiktierFlow
AppVersion={#MyAppVersion}
AppPublisher=ergoforyou
DefaultDirName={localappdata}\Programs\DiktierFlow
DefaultGroupName=DiktierFlow
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=DiktierFlow-Setup
SetupIconFile=diktierflow.ico
UninstallDisplayIcon={app}\DiktierFlow.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"

[Tasks]
Name: "desktopicon"; Description: "Verknüpfung auf dem Desktop"; Flags: unchecked
Name: "autostart"; Description: "DiktierFlow mit Windows starten"

[Files]
Source: "..\dist\DiktierFlow\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\DiktierFlow"; Filename: "{app}\DiktierFlow.exe"
Name: "{group}\DiktierFlow Selbsttest"; Filename: "{app}\DiktierFlow.exe"; Parameters: "--selbsttest"
Name: "{group}\DiktierFlow deinstallieren"; Filename: "{uninstallexe}"
Name: "{autodesktop}\DiktierFlow"; Filename: "{app}\DiktierFlow.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "DiktierFlow"; ValueData: """{app}\DiktierFlow.exe"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\DiktierFlow.exe"; Description: "DiktierFlow jetzt starten"; Flags: nowait postinstall skipifsilent
