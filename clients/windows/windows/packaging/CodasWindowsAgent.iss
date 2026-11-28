#define AppName "Codas for Windows"
#define AppVersion "0.2.0-rc.8"
[Setup]
AppId={{D66D0B7E-09B9-444A-A9BA-4886F70DFA13}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Codas
DefaultDirName={localappdata}\Programs\CodasWindowsAgent
DefaultGroupName=Codas
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=Codas-Windows-Agent-0.2.0-rc.8-x64-Setup
SetupIconFile=..\runner\resources\app_icon.ico
UninstallDisplayIcon={app}\CodasWindowsAgent.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
AppMutex=Local\CodasWindowsAgent-UI-v1
CloseApplications=yes
RestartApplications=no
[Files]
Source: "..\..\build\windows\x64\runner\Release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "README-Agent.txt"; DestDir: "{app}"; Flags: ignoreversion
[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked
[Icons]
Name: "{group}\Codas"; Filename: "{app}\CodasWindowsAgent.exe"
Name: "{userdesktop}\Codas"; Filename: "{app}\CodasWindowsAgent.exe"; Tasks: desktopicon
[Run]
Filename: "{app}\CodasWindowsAgent.exe"; Description: "Open Codas"; Flags: nowait postinstall skipifsilent unchecked
