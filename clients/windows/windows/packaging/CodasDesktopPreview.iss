#define AppName "Codas for Windows - Desktop Preview"
#define AppVersion "0.1.1"
[Setup]
AppId={{D92F1519-F06A-4631-9D50-B7F6191DE53D}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Codas
DefaultDirName={localappdata}\Programs\CodasDesktopPreview
DefaultGroupName=Codas Desktop Preview
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=Codas-Desktop-Preview-0.1.1-x64-Setup
SetupIconFile=..\runner\resources\app_icon.ico
UninstallDisplayIcon={app}\CodasDesktop.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
[Files]
Source: "..\..\build\windows\x64\runner\Release\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\Codas Desktop Preview"; Filename: "{app}\CodasDesktop.exe"; IconFilename: "{app}\CodasDesktop.exe"
[Run]
Filename: "{app}\CodasDesktop.exe"; Description: "Open Codas Desktop Preview"; Flags: nowait postinstall skipifsilent unchecked
