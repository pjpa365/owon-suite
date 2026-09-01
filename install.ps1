<#
  Downloads and installs a released build of Suite for OWON Devices: checks
  prerequisites (Bluetooth hardware, Python), asks the standard install
  questions (folder, port, Start Menu shortcut, Windows Service, auto-start),
  sets everything up, and leaves the app running.

  This is the one file meant to be downloaded and run directly -- it fetches
  a versioned release package (built by build-release.ps1, published as a
  GitHub Release asset) rather than assuming a git clone is already present.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Version 0.3.0

  The -InstallDir/-Port/-CreateShortcut/-CreateService/-AutoStart/
  -SkipBluetoothCheck parameters exist so this script can re-invoke itself
  elevated (see below) without re-asking questions already answered in the
  first pass -- not meant to be set by hand, though nothing stops it.
#>

param(
    [string]$Version = "",
    [string]$InstallDir = "",
    [string]$Port = "",
    [string]$CreateShortcut = "",   # "yes" / "no" / "" (ask)
    [string]$CreateService = "",    # "yes" / "no" / "" (ask)
    [string]$AutoStart = "",        # "yes" / "no" / "" (ask)
    [switch]$SkipBluetoothCheck
)

$ErrorActionPreference = "Stop"

$GitHubOwner = "pjpa365"
$GitHubRepo  = "owon-suite"
$ServiceName = "OwonSuite"

function Test-RequiresAdmin {
    # A folder under Program Files (or its x86 twin) needs admin rights to
    # write to -- used both to decide whether to self-elevate and where the
    # database should live (see below).
    param([string]$Path)
    $pf = $env:ProgramFiles
    $pfx86 = ${env:ProgramFiles(x86)}
    return ($Path -like "$pf*") -or ($pfx86 -and $Path -like "$pfx86*")
}

function Resolve-YesNo {
    param([string]$Value, [string]$Prompt, [bool]$DefaultYes)
    if ($Value -eq "yes") { return $true }
    if ($Value -eq "no") { return $false }
    $suffix = if ($DefaultYes) { "(Y/n)" } else { "(y/N)" }
    $answer = Read-Host "$Prompt $suffix"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $DefaultYes }
    return $answer -match '^[yY]'
}

function Test-PortFree {
    param([int]$Port)
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return -not $conns
}

function Test-RealPython {
    # Windows can register a "python" App Execution Alias that just opens
    # the Microsoft Store instead of running anything -- Get-Command alone
    # can't tell that apart from a real install, so actually run it.
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    try {
        $verOutput = & $cmd.Source --version 2>&1
        if ($LASTEXITCODE -eq 0 -and $verOutput -match 'Python \d') { return $cmd }
    } catch {}
    return $null
}

Write-Host "===============================================" -ForegroundColor Cyan
Write-Host " Suite for OWON Devices -- Installer" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------------
# Bluetooth pre-flight check
# ---------------------------------------------------------------------------
if (-not $SkipBluetoothCheck) {
    Write-Host "== Checking for a Bluetooth adapter ==" -ForegroundColor Cyan
    $btOk = $null
    try {
        $btOk = Get-PnpDevice -Class Bluetooth -PresentOnly -ErrorAction SilentlyContinue |
            Where-Object { $_.Status -eq 'OK' }
    } catch {
        Write-Host "Couldn't query Bluetooth hardware on this PC (unexpected) -- continuing anyway." -ForegroundColor Yellow
    }
    if ($btOk) {
        Write-Host "Bluetooth adapter found: $($btOk[0].FriendlyName)" -ForegroundColor Green
    } else {
        Write-Host "No working Bluetooth adapter/driver was detected on this PC." -ForegroundColor Yellow
        Write-Host "Suite for OWON Devices needs Bluetooth Low Energy to talk to a meter. If" -ForegroundColor Yellow
        Write-Host "Bluetooth is just switched off, or a USB dongle isn't plugged in yet, that's" -ForegroundColor Yellow
        Write-Host "fine to sort out after installing. If there's no Bluetooth hardware/driver" -ForegroundColor Yellow
        Write-Host "at all, device connection won't work until that's resolved." -ForegroundColor Yellow
        $answer = Read-Host "Continue installing anyway? (Y/n)"
        if ($answer -match '^[nN]') {
            Write-Host "Install cancelled." -ForegroundColor Red
            exit 1
        }
    }
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Install questions
# ---------------------------------------------------------------------------
if (-not $InstallDir) {
    $DefaultInstallDir = Join-Path $env:LOCALAPPDATA "Programs\OwonSuite"
    Write-Host "Where should Suite for OWON Devices be installed?" -ForegroundColor Cyan
    Write-Host "Default (recommended -- no administrator rights needed): $DefaultInstallDir"
    Write-Host "(A folder under Program Files also works, but needs administrator rights.)"
    $inputDir = Read-Host "Press Enter to accept, or type a different folder"
    $InstallDir = if ([string]::IsNullOrWhiteSpace($inputDir)) { $DefaultInstallDir } else { $inputDir }
    Write-Host ""
}

if (-not $Port) {
    $SuggestedPort = 10765
    while (-not (Test-PortFree -Port $SuggestedPort)) { $SuggestedPort++ }
    Write-Host "Which network port should the app use?" -ForegroundColor Cyan
    Write-Host "Default (currently free on this PC): $SuggestedPort"
    $inputPort = Read-Host "Press Enter to accept, or type a different port"
    $Port = if ([string]::IsNullOrWhiteSpace($inputPort)) { "$SuggestedPort" } else { $inputPort }
    Write-Host ""
}
if (-not (Test-PortFree -Port ([int]$Port))) {
    Write-Host "Port $Port looks like it's already in use on this PC -- pick a different one and re-run." -ForegroundColor Red
    exit 1
}

$CreateShortcutBool = Resolve-YesNo -Value $CreateShortcut -Prompt "Create a Start Menu shortcut?" -DefaultYes $true
$CreateServiceBool  = Resolve-YesNo -Value $CreateService  -Prompt "Create a Windows Service (so the app can run without staying logged in)?" -DefaultYes $false
$AutoStartBool      = Resolve-YesNo -Value $AutoStart      -Prompt "Start the app automatically when Windows boots?" -DefaultYes $false
Write-Host ""

# ---------------------------------------------------------------------------
# Elevate if needed (system-wide install folder and/or a Windows Service),
# passing the already-collected answers through so the elevated re-run
# doesn't ask again.
# ---------------------------------------------------------------------------
$NeedsAdmin = $CreateServiceBool -or (Test-RequiresAdmin -Path $InstallDir)
$CurrentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$IsAdmin = $CurrentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($NeedsAdmin -and -not $IsAdmin) {
    Write-Host "This install needs administrator rights (a system-wide folder and/or a Windows Service) -- relaunching elevated..." -ForegroundColor Yellow
    $argList = @(
        "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"",
        "-InstallDir", "`"$InstallDir`"",
        "-Port", "$Port",
        "-CreateShortcut", $(if ($CreateShortcutBool) { "yes" } else { "no" }),
        "-CreateService", $(if ($CreateServiceBool) { "yes" } else { "no" }),
        "-AutoStart", $(if ($AutoStartBool) { "yes" } else { "no" }),
        "-SkipBluetoothCheck"
    )
    if ($Version) { $argList += @("-Version", "`"$Version`"") }
    Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait
    exit
}

$UsesProgramData = Test-RequiresAdmin -Path $InstallDir

# ---------------------------------------------------------------------------
# Existing-database detection (e.g. re-running the installer / an upgrade)
# ---------------------------------------------------------------------------
if ($UsesProgramData) {
    $DbDataDir = Join-Path $env:ProgramData "OwonSuite"
    New-Item -ItemType Directory -Force -Path $DbDataDir | Out-Null
    $DbPath = Join-Path $DbDataDir "owon_meter.duckdb"
} else {
    $DbPath = $null  # left relative -- config.py resolves "owon_meter.duckdb" against the backend folder itself
}
$DbCheckPath = if ($DbPath) { $DbPath } else { Join-Path $InstallDir "backend\owon_meter.duckdb" }
if (Test-Path $DbCheckPath) {
    Write-Host "Found an existing database at $DbCheckPath (from a previous install) -- keeping it." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Python prerequisite
# ---------------------------------------------------------------------------
Write-Host "== Checking for Python ==" -ForegroundColor Cyan
$pythonCmd = Test-RealPython
if (-not $pythonCmd) {
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $wingetCmd) {
        Write-Host "Python isn't installed, and winget (Windows Package Manager) isn't available to install it automatically." -ForegroundColor Red
        Write-Host "Install Python 3.11 or later from https://python.org/downloads/, then re-run this script." -ForegroundColor Red
        exit 1
    }
    Write-Host "Python not found -- installing via winget (needs internet access)..." -ForegroundColor Yellow
    winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget install of Python failed (exit code $LASTEXITCODE)" }
    # winget updates the machine/user PATH, but this already-running process
    # doesn't see that until it's re-read from the registry.
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")
    $pythonCmd = Test-RealPython
    if (-not $pythonCmd) {
        Write-Host "Python was installed but isn't on PATH in this window yet -- close this window, open a new PowerShell, and re-run this script." -ForegroundColor Red
        exit 1
    }
}
Write-Host "Python found: $($pythonCmd.Source)" -ForegroundColor Green
Write-Host ""

# ---------------------------------------------------------------------------
# Download + extract the release package
# ---------------------------------------------------------------------------
Write-Host "== Finding release package ==" -ForegroundColor Cyan
$ApiUrl = if ($Version) {
    "https://api.github.com/repos/$GitHubOwner/$GitHubRepo/releases/tags/v$Version"
} else {
    "https://api.github.com/repos/$GitHubOwner/$GitHubRepo/releases/latest"
}
try {
    $release = Invoke-RestMethod -Uri $ApiUrl -Headers @{ "User-Agent" = "OwonSuite-Installer" }
} catch {
    throw "Couldn't reach GitHub to find a release ($ApiUrl): $($_.Exception.Message)"
}
$asset = $release.assets | Where-Object { $_.name -like "owon-suite-v*.zip" } | Select-Object -First 1
if (-not $asset) {
    throw "Release '$($release.tag_name)' has no owon-suite-v*.zip file attached."
}

$TempDir = Join-Path $env:TEMP "owon-install-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
$ZipPath = Join-Path $TempDir $asset.name
Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $ZipPath

Write-Host "== Extracting ==" -ForegroundColor Cyan
$ExtractDir = Join-Path $TempDir "extracted"
Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir
Write-Host ""

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
Write-Host "== Installing to $InstallDir ==" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
# Copy-Item merges into an existing destination rather than replacing it, so
# a pre-existing database file (not present in the fresh release contents)
# is left untouched by this.
Copy-Item -Path (Join-Path $ExtractDir "backend") -Destination (Join-Path $InstallDir "backend") -Recurse -Force
Copy-Item -Path (Join-Path $ExtractDir "frontend") -Destination (Join-Path $InstallDir "frontend") -Recurse -Force
Remove-Item $TempDir -Recurse -Force

$BackendInstallDir = Join-Path $InstallDir "backend"

Write-Host "== Setting up the Python environment (this can take a minute) ==" -ForegroundColor Cyan
& $pythonCmd.Source -m venv (Join-Path $BackendInstallDir ".venv")
if ($LASTEXITCODE -ne 0) { throw "Failed to create the Python virtual environment (exit code $LASTEXITCODE)" }
$VenvPython = Join-Path $BackendInstallDir ".venv\Scripts\python.exe"
& $VenvPython -m pip install --upgrade pip --quiet
& $VenvPython -m pip install -r (Join-Path $BackendInstallDir "requirements-lock.txt") --quiet
if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit code $LASTEXITCODE)" }
Write-Host ""

Write-Host "== Writing configuration ==" -ForegroundColor Cyan
$ConfigLines = @(
    "# Generated by install.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss').",
    "# Edit HOST/PORT here if you ever need to change them, then restart the app.",
    "HOST=127.0.0.1",
    "PORT=$Port",
    "BUFFER_SIZE=1000",
    "DB_PATH=$(if ($DbPath) { $DbPath } else { 'owon_meter.duckdb' })"
)
$ConfigLines -join "`r`n" | Set-Content -Path (Join-Path $BackendInstallDir "config.env") -Encoding utf8

$StartScriptPath = Join-Path $InstallDir "start-app.ps1"
@"
# Starts Suite for OWON Devices and opens it in your browser.
# Double-click this file, or run:
#   powershell -ExecutionPolicy Bypass -File "$StartScriptPath"
`$ErrorActionPreference = "Stop"
Start-Process -FilePath "$VenvPython" -ArgumentList "run_prod.py" -WorkingDirectory "$BackendInstallDir" -WindowStyle Minimized
`$url = "http://127.0.0.1:$Port"
`$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Milliseconds 500
    try {
        `$resp = Invoke-WebRequest -Uri "`$url/docs" -UseBasicParsing -TimeoutSec 2
        if (`$resp.StatusCode -eq 200) { break }
    } catch {}
} while ((Get-Date) -lt `$deadline)
Start-Process `$url
"@ | Set-Content -Path $StartScriptPath -Encoding utf8
Write-Host ""

if ($CreateShortcutBool) {
    Write-Host "== Creating Start Menu shortcut ==" -ForegroundColor Cyan
    $StartMenuPrograms = if ($UsesProgramData) {
        Join-Path ([System.Environment]::GetFolderPath("CommonStartMenu")) "Programs"
    } else {
        Join-Path ([System.Environment]::GetFolderPath("StartMenu")) "Programs"
    }
    $ShortcutPath = Join-Path $StartMenuPrograms "Suite for OWON Devices.lnk"
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = "powershell.exe"
    $Shortcut.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScriptPath`""
    $Shortcut.WorkingDirectory = $InstallDir
    $Shortcut.Description = "Start Suite for OWON Devices"
    $Shortcut.Save()
    Write-Host "Shortcut created: $ShortcutPath" -ForegroundColor Green
    Write-Host ""
}

if ($CreateServiceBool) {
    Write-Host "== Setting up the Windows Service ==" -ForegroundColor Cyan
    $NssmVersion = "2.24"
    $NssmZipUrl = "https://nssm.cc/release/nssm-$NssmVersion.zip"
    $NssmZipPath = Join-Path $env:TEMP "nssm-$NssmVersion.zip"
    Invoke-WebRequest -Uri $NssmZipUrl -OutFile $NssmZipPath
    $NssmExtractDir = Join-Path $env:TEMP "nssm-extract-$(Get-Random)"
    Expand-Archive -Path $NssmZipPath -DestinationPath $NssmExtractDir
    $Arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
    $NssmPath = Join-Path $InstallDir "nssm.exe"
    Copy-Item -Path (Join-Path $NssmExtractDir "nssm-$NssmVersion\$Arch\nssm.exe") -Destination $NssmPath -Force
    Remove-Item $NssmZipPath, $NssmExtractDir -Recurse -Force

    & $NssmPath install $ServiceName "$VenvPython" "run_prod.py"
    & $NssmPath set $ServiceName AppDirectory "$BackendInstallDir"
    & $NssmPath set $ServiceName DisplayName "Suite for OWON Devices"
    & $NssmPath set $ServiceName Description "Backend for Suite for OWON Devices (OWON meter dashboard) -- open http://127.0.0.1:$Port"
    & $NssmPath set $ServiceName Start SERVICE_DEMAND_START
    Write-Host "Windows Service '$ServiceName' created." -ForegroundColor Green
    Write-Host ""
}

if ($AutoStartBool) {
    Write-Host "== Enabling auto-start on boot ==" -ForegroundColor Cyan
    if ($CreateServiceBool) {
        $NssmPath = Join-Path $InstallDir "nssm.exe"
        & $NssmPath set $ServiceName Start SERVICE_AUTO_START
        Write-Host "The Windows Service will now start automatically with Windows." -ForegroundColor Green
    } else {
        $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScriptPath`""
        $Trigger = New-ScheduledTaskTrigger -AtLogOn
        $Settings = New-ScheduledTaskSettingsSet -Hidden
        Register-ScheduledTask -TaskName "OwonSuite AutoStart" -Action $Action -Trigger $Trigger -Settings $Settings `
            -Description "Starts Suite for OWON Devices when you log in" -Force | Out-Null
        Write-Host "A Scheduled Task will start the app the next time you log in." -ForegroundColor Green
    }
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Start it now and verify
# ---------------------------------------------------------------------------
Write-Host "== Starting the app ==" -ForegroundColor Cyan
if ($CreateServiceBool) {
    Start-Service -Name $ServiceName
} else {
    Start-Process -FilePath $VenvPython -ArgumentList "run_prod.py" -WorkingDirectory $BackendInstallDir -WindowStyle Minimized
}

$HealthUrl = "http://127.0.0.1:$Port/docs"
$deadline = (Get-Date).AddSeconds(30)
$ok = $false
do {
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) { $ok = $true; break }
    } catch {}
} while ((Get-Date) -lt $deadline)

Write-Host ""
Write-Host "===============================================" -ForegroundColor Cyan
if ($ok) {
    Write-Host "Suite for OWON Devices is installed and running." -ForegroundColor Green
} else {
    Write-Host "Installed, but the app didn't respond within 30 seconds -- check for errors above." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Open it at:  http://127.0.0.1:$Port" -ForegroundColor Green
if ($CreateShortcutBool) {
    Write-Host "Start Menu shortcut: 'Suite for OWON Devices' (starts it and opens your browser)" -ForegroundColor Green
}
Write-Host ""
Write-Host "To (re)start it manually next time:" -ForegroundColor Cyan
if ($CreateServiceBool) {
    Write-Host "  It runs as a Windows Service ('$ServiceName') -- manage it via services.msc, or:"
    Write-Host "    Start-Service $ServiceName"
    Write-Host "    Stop-Service $ServiceName"
} elseif ($CreateShortcutBool) {
    Write-Host "  Click the 'Suite for OWON Devices' Start Menu shortcut."
} else {
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$StartScriptPath`""
}
Write-Host "===============================================" -ForegroundColor Cyan
