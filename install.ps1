<#
  Downloads and installs a released build of Suite for OWON Devices: checks
  prerequisites (Bluetooth hardware, Python), asks the standard install
  questions (scope, folder, port, Start Menu shortcut, Windows Service,
  auto-start), detects and offers to upgrade/reinstall/remove an existing
  install, sets everything up, and leaves the app running.

  This is the one file meant to be downloaded and run directly -- it fetches
  a versioned release package (built by build-release.ps1, published as a
  GitHub Release asset) rather than assuming a git clone is already present.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Version 0.1

  The other parameters exist so this script can re-invoke itself elevated,
  or skip questions already answered in a first pass -- not meant to be set
  by hand, though nothing stops it.
#>

param(
    [string]$Version = "",
    [string]$AllUsers = "",         # "yes" / "no" / "" (ask)
    [string]$InstallDir = "",
    [string]$ExistingAction = "",   # "upgrade" / "reinstall" / "remove" / "cancel" / "" (detect+ask)
    [string]$KeepDb = "",           # "yes" / "no" / "" (ask when relevant)
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
$AppTitle    = "Suite for OWON Devices"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Test-RequiresAdmin {
    # A folder under Program Files (or its x86 twin) needs admin rights to
    # write to -- used as a backstop in case a Program-Files path is typed
    # by hand even after answering "just this user" to the scope question.
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

function Stop-ProcessTree {
    param([int]$RootId)
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$RootId" -ErrorAction SilentlyContinue
    foreach ($child in $children) { Stop-ProcessTree -RootId $child.ProcessId }
    try { Stop-Process -Id $RootId -Force -ErrorAction Stop } catch {}
}

function Stop-RunningApp {
    # Stops whatever's currently running for an existing install, whether
    # it's a Windows Service or a plain background process -- used before
    # upgrading/reinstalling/removing so files being replaced aren't locked.
    param($Manifest, [string]$Dir)
    if ($Manifest.ServiceCreated) {
        Stop-Service -Name $Manifest.ServiceName -Force -ErrorAction SilentlyContinue
    } else {
        $PidFile = Join-Path $Dir "owon-pids.json"
        if (Test-Path $PidFile) {
            $prev = Get-Content $PidFile -Raw | ConvertFrom-Json
            if ($prev.BackendPid) { Stop-ProcessTree -RootId $prev.BackendPid }
            Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 1
}

$CurrentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$IsAdmin = $CurrentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Request-Elevation {
    # Re-invokes this script elevated, passing through every already-
    # resolved answer so the elevated pass doesn't ask anything twice.
    param([hashtable]$Params)
    Write-Host "This step needs administrator rights -- Windows will now show a permission prompt; click Yes to continue." -ForegroundColor Yellow
    # $PSCommandPath is empty when this script was run via `irm ... | iex`
    # (no local file backs it) rather than `-File` -- download a copy so the
    # elevated relaunch has an actual file to point at.
    $ScriptPathForRelaunch = $PSCommandPath
    if (-not $ScriptPathForRelaunch) {
        $ScriptPathForRelaunch = Join-Path $env:TEMP "owon-install-$(Get-Random).ps1"
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$GitHubOwner/$GitHubRepo/master/install.ps1" -OutFile $ScriptPathForRelaunch
    }
    $argList = @("-ExecutionPolicy", "Bypass", "-File", "`"$ScriptPathForRelaunch`"", "-SkipBluetoothCheck")
    foreach ($key in $Params.Keys) {
        $val = $Params[$key]
        if ($null -ne $val -and "$val" -ne "") { $argList += @("-$key", "`"$val`"") }
    }
    Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait
    exit
}

Write-Host "===============================================" -ForegroundColor Cyan
Write-Host " $AppTitle -- Installer" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------------------
# Bluetooth pre-flight check
# ---------------------------------------------------------------------------
if (-not $SkipBluetoothCheck) {
    Write-Host "Checking for a Bluetooth adapter..." -ForegroundColor Cyan
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
        Write-Host "$AppTitle needs Bluetooth Low Energy to talk to a meter. If Bluetooth is" -ForegroundColor Yellow
        Write-Host "just switched off, or a USB dongle isn't plugged in yet, that's fine to sort" -ForegroundColor Yellow
        Write-Host "out after installing. If there's no Bluetooth hardware/driver at all, device" -ForegroundColor Yellow
        Write-Host "connection won't work until that's resolved." -ForegroundColor Yellow
        $answer = Read-Host "Continue installing anyway? (Y/n)"
        if ($answer -match '^[nN]') {
            Write-Host "Install cancelled." -ForegroundColor Red
            exit 1
        }
    }
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Find the release (queried early: needed both to offer/label "Upgrade" in
# the existing-install menu below, and later to actually download it)
# ---------------------------------------------------------------------------
Write-Host "Checking for the release to install..." -ForegroundColor Cyan
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
$ReleaseVersion = $release.tag_name.TrimStart("v")
Write-Host "Found release v$ReleaseVersion." -ForegroundColor Green
Write-Host ""

# ---------------------------------------------------------------------------
# [1/6] Install scope
# ---------------------------------------------------------------------------
if (-not $AllUsers) {
    Write-Host "[1/6] Install for just yourself, or for all users on this PC?" -ForegroundColor Cyan
    Write-Host "  1) Only this user (recommended -- no administrator rights needed)"
    Write-Host "  2) All users on this PC (needs administrator rights)"
    $choice = Read-Host "Choice (Enter for 1)"
    $AllUsersBool = ($choice.Trim() -eq "2")
} else {
    $AllUsersBool = ($AllUsers -eq "yes")
}
Write-Host ""

# ---------------------------------------------------------------------------
# [2/6] Install folder
# ---------------------------------------------------------------------------
if (-not $InstallDir) {
    $DefaultInstallDir = if ($AllUsersBool) {
        Join-Path $env:ProgramFiles "OwonSuite"
    } else {
        Join-Path $env:LOCALAPPDATA "Programs\OwonSuite"
    }
    Write-Host "[2/6] Where should $AppTitle be installed?" -ForegroundColor Cyan
    Write-Host "Default: $DefaultInstallDir"
    $inputDir = Read-Host "Press Enter to accept, or type a different folder"
    $InstallDir = if ([string]::IsNullOrWhiteSpace($inputDir)) { $DefaultInstallDir } else { $inputDir }
}
Write-Host ""

$NeedsAdminForScope = $AllUsersBool -or (Test-RequiresAdmin -Path $InstallDir)

# ---------------------------------------------------------------------------
# Existing-install detection
# ---------------------------------------------------------------------------
Write-Host "Checking for an existing install at $InstallDir..." -ForegroundColor Cyan
$ManifestPath = Join-Path $InstallDir "install-manifest.json"
$ExistingManifest = $null
if (Test-Path $ManifestPath) {
    $ExistingManifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
}
if (-not $ExistingManifest -and -not $ExistingAction) {
    Write-Host "No existing install found -- proceeding with a new install." -ForegroundColor Green
}

if ($ExistingManifest -and -not $ExistingAction) {
    Write-Host "An existing install (v$($ExistingManifest.Version)) was found at $InstallDir." -ForegroundColor Yellow
    $optionNum = 1
    $offerUpgrade = $ExistingManifest.Version -ne $ReleaseVersion
    if ($offerUpgrade) {
        Write-Host "  $optionNum) Upgrade to v$ReleaseVersion (keeps your existing data)"
        $upgradeOption = $optionNum
        $optionNum++
    }
    Write-Host "  $optionNum) Reinstall v$ReleaseVersion"
    $reinstallOption = $optionNum
    $optionNum++
    Write-Host "  $optionNum) Remove this installation"
    $removeOption = $optionNum
    $optionNum++
    Write-Host "  $optionNum) Cancel (make no changes)"
    $cancelOption = $optionNum

    $choice = Read-Host "Choice"
    $ExistingAction = if ($offerUpgrade -and $choice -eq "$upgradeOption") { "upgrade" }
        elseif ($choice -eq "$reinstallOption") { "reinstall" }
        elseif ($choice -eq "$removeOption") { "remove" }
        else { "cancel" }
}
Write-Host ""

if ($ExistingAction -eq "cancel") {
    Write-Host "No changes made." -ForegroundColor Cyan
    exit 0
}

if ($ExistingAction -eq "remove") {
    $NeedsAdmin = $NeedsAdminForScope -or ($ExistingManifest -and $ExistingManifest.ServiceCreated)
    if ($NeedsAdmin -and -not $IsAdmin) {
        Request-Elevation -Params @{
            Version = $Version; AllUsers = $(if ($AllUsersBool) { "yes" } else { "no" })
            InstallDir = $InstallDir; ExistingAction = "remove"
        }
    }
    & (Join-Path $InstallDir "uninstall.ps1")
    exit 0
}

if ($ExistingAction -eq "reinstall" -and -not $KeepDb) {
    Write-Host "Reinstalling v$ReleaseVersion over the existing v$($ExistingManifest.Version) install." -ForegroundColor Cyan
    $answer = Read-Host "Keep the existing database (recorded measurements)? (Y/n)"
    $KeepDb = if ($answer -match '^[nN]') { "no" } else { "yes" }
    Write-Host ""
}

# ---------------------------------------------------------------------------
# [3/6]-[6/6]: port / shortcut / service / auto-start -- skipped entirely
# for "upgrade" (reuses the existing manifest's answers as-is)
# ---------------------------------------------------------------------------
if ($ExistingAction -eq "upgrade") {
    $Port = "$($ExistingManifest.Port)"
    $CreateShortcut = if ($ExistingManifest.ShortcutFolderPath) { "yes" } else { "no" }
    $CreateService  = if ($ExistingManifest.ServiceCreated) { "yes" } else { "no" }
    $AutoStart      = if ($ExistingManifest.AutoStartCreated) { "yes" } else { "no" }
} else {
    if (-not $Port) {
        $SuggestedPort = if ($ExistingManifest -and (Test-PortFree -Port ([int]$ExistingManifest.Port))) {
            [int]$ExistingManifest.Port
        } else {
            $p = 10765
            while (-not (Test-PortFree -Port $p)) { $p++ }
            $p
        }
        Write-Host "[3/6] Which network port should the app use?" -ForegroundColor Cyan
        Write-Host "Default (currently free on this PC): $SuggestedPort"
        $inputPort = Read-Host "Press Enter to accept, or type a different port"
        $Port = if ([string]::IsNullOrWhiteSpace($inputPort)) { "$SuggestedPort" } else { $inputPort }
        Write-Host ""
    }
    if (-not (Test-PortFree -Port ([int]$Port))) {
        Write-Host "Port $Port looks like it's already in use on this PC -- pick a different one and re-run." -ForegroundColor Red
        exit 1
    }

    $shortcutDefault = if ($ExistingManifest) { [bool]$ExistingManifest.ShortcutFolderPath } else { $true }
    $serviceDefault  = if ($ExistingManifest) { [bool]$ExistingManifest.ServiceCreated } else { $false }
    $autoStartDefault = if ($ExistingManifest) { [bool]$ExistingManifest.AutoStartCreated } else { $false }

    Write-Host "[4/6] " -NoNewline -ForegroundColor Cyan
    $CreateShortcutBool = Resolve-YesNo -Value $CreateShortcut -Prompt "Create a '$AppTitle' Start Menu folder with shortcuts (Start, Stop, Upgrade/Uninstall)?" -DefaultYes $shortcutDefault
    Write-Host "[5/6] " -NoNewline -ForegroundColor Cyan
    $CreateServiceBool  = Resolve-YesNo -Value $CreateService  -Prompt "Create a Windows Service (so the app can run without staying logged in)?" -DefaultYes $serviceDefault
    Write-Host "[6/6] " -NoNewline -ForegroundColor Cyan
    $AutoStartBool      = Resolve-YesNo -Value $AutoStart      -Prompt "Start the app automatically when Windows boots?" -DefaultYes $autoStartDefault
    Write-Host ""
}
$CreateShortcutBool = ($CreateShortcut -eq "yes") -or ($CreateShortcutBool -eq $true)
$CreateServiceBool  = ($CreateService -eq "yes") -or ($CreateServiceBool -eq $true)
$AutoStartBool      = ($AutoStart -eq "yes") -or ($AutoStartBool -eq $true)

# ---------------------------------------------------------------------------
# Elevate if needed, now that every answer is known
# ---------------------------------------------------------------------------
$NeedsAdmin = $NeedsAdminForScope -or $CreateServiceBool
if ($NeedsAdmin -and -not $IsAdmin) {
    Request-Elevation -Params @{
        Version = $Version
        AllUsers = $(if ($AllUsersBool) { "yes" } else { "no" })
        InstallDir = $InstallDir
        ExistingAction = $ExistingAction
        KeepDb = $KeepDb
        Port = $Port
        CreateShortcut = $(if ($CreateShortcutBool) { "yes" } else { "no" })
        CreateService = $(if ($CreateServiceBool) { "yes" } else { "no" })
        AutoStart = $(if ($AutoStartBool) { "yes" } else { "no" })
    }
}

$UsesProgramData = Test-RequiresAdmin -Path $InstallDir

# ---------------------------------------------------------------------------
# Compute the numbered installation-step list, based on what will actually run
# ---------------------------------------------------------------------------
$Steps = New-Object 'System.Collections.Generic.List[string]'
if ($ExistingAction -in @("upgrade", "reinstall")) { $Steps.Add("Stopping the current install") }
$Steps.Add("Checking for Python")
$Steps.Add("Downloading the release")
$Steps.Add("Installing files")
$Steps.Add("Setting up the Python environment")
$Steps.Add("Writing configuration")
if ($CreateShortcutBool) { $Steps.Add("Creating Start Menu shortcuts") }
if ($CreateServiceBool) { $Steps.Add("Setting up the Windows Service") }
if ($AutoStartBool) { $Steps.Add("Enabling auto-start") }
$Steps.Add("Starting the app")
$StepIndex = 0
function Write-Step {
    param([string]$Text)
    $script:StepIndex++
    Write-Host "[$script:StepIndex/$($Steps.Count)] $Text" -ForegroundColor Cyan
}

if ($ExistingAction -in @("upgrade", "reinstall")) {
    Write-Step $Steps[$StepIndex]
    Stop-RunningApp -Manifest $ExistingManifest -Dir $InstallDir
}

# ---------------------------------------------------------------------------
# Database path + fresh-DB handling
# ---------------------------------------------------------------------------
if ($UsesProgramData) {
    $DbDataDir = Join-Path $env:ProgramData "OwonSuite"
    New-Item -ItemType Directory -Force -Path $DbDataDir | Out-Null
    $DbPath = Join-Path $DbDataDir "owon_meter.duckdb"
} else {
    $DbPath = $null  # left relative -- config.py resolves "owon_meter.duckdb" against the backend folder itself
}
$DbCheckPath = if ($DbPath) { $DbPath } else { Join-Path $InstallDir "backend\owon_meter.duckdb" }
if ($ExistingAction -eq "reinstall" -and $KeepDb -eq "no" -and (Test-Path $DbCheckPath)) {
    Remove-Item $DbCheckPath, "$DbCheckPath.wal" -Force -ErrorAction SilentlyContinue
    Write-Host "Starting with a fresh, empty database as requested." -ForegroundColor Yellow
} elseif (Test-Path $DbCheckPath) {
    Write-Host "Keeping the existing database at $DbCheckPath." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Python prerequisite
# ---------------------------------------------------------------------------
Write-Step "Checking for Python"
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
Write-Step "Downloading the release"
$TempDir = Join-Path $env:TEMP "owon-install-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
$ZipPath = Join-Path $TempDir $asset.name
Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $ZipPath

$ExtractDir = Join-Path $TempDir "extracted"
Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir
Write-Host ""

# ---------------------------------------------------------------------------
# Install files
# ---------------------------------------------------------------------------
Write-Step "Installing files"
Write-Host "Installing to $InstallDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
# Copy-Item merges into an existing destination rather than replacing it, so
# a pre-existing database file (not present in the fresh release contents)
# is left untouched by this.
Copy-Item -Path (Join-Path $ExtractDir "backend") -Destination (Join-Path $InstallDir "backend") -Recurse -Force
Copy-Item -Path (Join-Path $ExtractDir "frontend") -Destination (Join-Path $InstallDir "frontend") -Recurse -Force
Copy-Item -Path (Join-Path $ExtractDir "uninstall.ps1") -Destination (Join-Path $InstallDir "uninstall.ps1") -Force
Remove-Item $TempDir -Recurse -Force

$BackendInstallDir = Join-Path $InstallDir "backend"
$IconPath = Join-Path $InstallDir "frontend\dist\logo.ico"

Write-Step "Setting up the Python environment"
Write-Host "(this can take a minute)" -ForegroundColor Cyan
& $pythonCmd.Source -m venv (Join-Path $BackendInstallDir ".venv")
if ($LASTEXITCODE -ne 0) { throw "Failed to create the Python virtual environment (exit code $LASTEXITCODE)" }
$VenvPython = Join-Path $BackendInstallDir ".venv\Scripts\python.exe"
& $VenvPython -m pip install --upgrade pip
& $VenvPython -m pip install -r (Join-Path $BackendInstallDir "requirements-lock.txt")
if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit code $LASTEXITCODE)" }
Write-Host ""

Write-Step "Writing configuration"
$ConfigLines = @(
    "# Generated by install.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss').",
    "# Edit HOST/PORT here if you ever need to change them, then restart the app.",
    "HOST=127.0.0.1",
    "PORT=$Port",
    "BUFFER_SIZE=1000",
    "DB_PATH=$(if ($DbPath) { $DbPath } else { 'owon_meter.duckdb' })"
)
$ConfigLines -join "`r`n" | Set-Content -Path (Join-Path $BackendInstallDir "config.env") -Encoding utf8

# start-app.ps1: launches the backend fully hidden (no window at all -- see
# stop-app.ps1 for how to stop it since there's no window to close anymore),
# tracks its PID, skips launching a second copy if one's already answering,
# and opens the browser once it's up. Startup can genuinely take >10s (real
# Python/DuckDB/BLE-discovery-loop cold start, same reason restart-dev.ps1's
# own health check waits up to 60s) -- so this waits up to 60s too rather
# than reporting a merely-slow start as a failure.
$StartScriptPath = Join-Path $InstallDir "start-app.ps1"
$PidFilePath = Join-Path $InstallDir "owon-pids.json"
@"
# Starts $AppTitle (hidden, no window) and opens it in your browser.
# Double-click this file, or run:
#   powershell -ExecutionPolicy Bypass -File "$StartScriptPath"
`$ErrorActionPreference = "Stop"
`$url = "http://127.0.0.1:$Port"

`$alreadyUp = `$false
try {
    `$resp = Invoke-WebRequest -Uri "`$url/docs" -UseBasicParsing -TimeoutSec 2
    if (`$resp.StatusCode -eq 200) { `$alreadyUp = `$true }
} catch {}

if (-not `$alreadyUp) {
    `$proc = Start-Process -FilePath "$VenvPython" -ArgumentList "run_prod.py" -WorkingDirectory "$BackendInstallDir" -WindowStyle Hidden -PassThru
    @{ BackendPid = `$proc.Id } | ConvertTo-Json | Set-Content -Path "$PidFilePath" -Encoding utf8
    `$deadline = (Get-Date).AddSeconds(60)
    do {
        Start-Sleep -Milliseconds 500
        try {
            `$resp = Invoke-WebRequest -Uri "`$url/docs" -UseBasicParsing -TimeoutSec 2
            if (`$resp.StatusCode -eq 200) { break }
        } catch {}
    } while ((Get-Date) -lt `$deadline)
}
Start-Process `$url
"@ | Set-Content -Path $StartScriptPath -Encoding utf8

# stop-app.ps1: companion to the above, since there's no window to close
# anymore -- reads the tracked PID and stops the process tree.
$StopScriptPath = Join-Path $InstallDir "stop-app.ps1"
@"
# Stops $AppTitle. Double-click this file, or run:
#   powershell -ExecutionPolicy Bypass -File "$StopScriptPath"
function Stop-ProcessTree {
    param([int]`$RootId)
    `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId=`$RootId" -ErrorAction SilentlyContinue
    foreach (`$child in `$children) { Stop-ProcessTree -RootId `$child.ProcessId }
    try { Stop-Process -Id `$RootId -Force -ErrorAction Stop; Write-Host "Stopped." } catch { Write-Host "Already stopped." }
}
if (Test-Path "$PidFilePath") {
    `$prev = Get-Content "$PidFilePath" -Raw | ConvertFrom-Json
    if (`$prev.BackendPid) { Stop-ProcessTree -RootId `$prev.BackendPid }
    Remove-Item "$PidFilePath" -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "$AppTitle doesn't look like it's running."
}
"@ | Set-Content -Path $StopScriptPath -Encoding utf8
Write-Host ""

$ShortcutFolderPath = ""
if ($CreateShortcutBool) {
    Write-Step "Creating Start Menu shortcuts"
    $StartMenuPrograms = if ($UsesProgramData) {
        Join-Path ([System.Environment]::GetFolderPath("CommonStartMenu")) "Programs"
    } else {
        Join-Path ([System.Environment]::GetFolderPath("StartMenu")) "Programs"
    }
    $ShortcutFolderPath = Join-Path $StartMenuPrograms $AppTitle
    New-Item -ItemType Directory -Force -Path $ShortcutFolderPath | Out-Null
    $WshShell = New-Object -ComObject WScript.Shell

    # IconLocation's documented format is "path,index" -- a bare path works
    # for most single-image .ico files too, but the explicit ",0" is the
    # correct form and avoids relying on that fallback.
    $HasIcon = Test-Path $IconPath
    if (-not $HasIcon) {
        Write-Host "Icon not found at $IconPath -- shortcuts will use a default icon." -ForegroundColor Yellow
    }

    $StartShortcut = $WshShell.CreateShortcut((Join-Path $ShortcutFolderPath "Start app.lnk"))
    $StartShortcut.TargetPath = "powershell.exe"
    $StartShortcut.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScriptPath`""
    $StartShortcut.WorkingDirectory = $InstallDir
    $StartShortcut.Description = "Start $AppTitle"
    if ($HasIcon) { $StartShortcut.IconLocation = "$IconPath,0" }
    $StartShortcut.Save()

    $StopShortcut = $WshShell.CreateShortcut((Join-Path $ShortcutFolderPath "Stop app.lnk"))
    $StopShortcut.TargetPath = "powershell.exe"
    $StopShortcut.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StopScriptPath`""
    $StopShortcut.WorkingDirectory = $InstallDir
    $StopShortcut.Description = "Stop $AppTitle"
    if ($HasIcon) { $StopShortcut.IconLocation = "$IconPath,0" }
    $StopShortcut.Save()

    # Interactive (a visible window, unlike Start/Stop above) -- re-running
    # the installer already detects this install and offers Upgrade/
    # Reinstall/Remove, so this needs no new logic, just the shortcut.
    # Always fetches the current install.ps1 from GitHub rather than a copy
    # frozen at this moment, so it stays correct even after a future fix.
    $UpgradeShortcut = $WshShell.CreateShortcut((Join-Path $ShortcutFolderPath "Upgrade or uninstall.lnk"))
    $UpgradeShortcut.TargetPath = "powershell.exe"
    $UpgradeShortcut.Arguments = "-ExecutionPolicy Bypass -NoExit -Command `"irm https://raw.githubusercontent.com/$GitHubOwner/$GitHubRepo/master/install.ps1 | iex`""
    $UpgradeShortcut.WorkingDirectory = $InstallDir
    $UpgradeShortcut.Description = "Upgrade or uninstall $AppTitle"
    if ($HasIcon) { $UpgradeShortcut.IconLocation = "$IconPath,0" }
    $UpgradeShortcut.Save()

    Write-Host "Start Menu folder created: '$AppTitle' (Start app / Stop app / Upgrade or uninstall)" -ForegroundColor Green
    Write-Host ""
}

if ($CreateServiceBool) {
    Write-Step "Setting up the Windows Service"
    $NssmPath = Join-Path $InstallDir "nssm.exe"
    if (-not (Test-Path $NssmPath)) {
        $NssmVersion = "2.24"
        $NssmZipUrl = "https://nssm.cc/release/nssm-$NssmVersion.zip"
        $NssmZipPath = Join-Path $env:TEMP "nssm-$NssmVersion.zip"
        Invoke-WebRequest -Uri $NssmZipUrl -OutFile $NssmZipPath
        $NssmExtractDir = Join-Path $env:TEMP "nssm-extract-$(Get-Random)"
        Expand-Archive -Path $NssmZipPath -DestinationPath $NssmExtractDir
        $Arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
        Copy-Item -Path (Join-Path $NssmExtractDir "nssm-$NssmVersion\$Arch\nssm.exe") -Destination $NssmPath -Force
        Remove-Item $NssmZipPath, $NssmExtractDir -Recurse -Force
    }

    & $NssmPath install $ServiceName "$VenvPython" "run_prod.py" 2>$null
    & $NssmPath set $ServiceName AppDirectory "$BackendInstallDir"
    & $NssmPath set $ServiceName DisplayName "$AppTitle"
    & $NssmPath set $ServiceName Description "Backend for $AppTitle (OWON meter dashboard) -- open http://127.0.0.1:$Port"
    & $NssmPath set $ServiceName Start SERVICE_DEMAND_START
    Write-Host "Windows Service '$ServiceName' created." -ForegroundColor Green
    Write-Host ""
}

if ($AutoStartBool) {
    Write-Step "Enabling auto-start"
    if ($CreateServiceBool) {
        $NssmPath = Join-Path $InstallDir "nssm.exe"
        & $NssmPath set $ServiceName Start SERVICE_AUTO_START
        Write-Host "The Windows Service will now start automatically with Windows." -ForegroundColor Green
    } else {
        $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScriptPath`""
        $Trigger = New-ScheduledTaskTrigger -AtLogOn
        $Settings = New-ScheduledTaskSettingsSet -Hidden
        Register-ScheduledTask -TaskName "OwonSuite AutoStart" -Action $Action -Trigger $Trigger -Settings $Settings `
            -Description "Starts $AppTitle when you log in" -Force | Out-Null
        Write-Host "A Scheduled Task will start the app the next time you log in." -ForegroundColor Green
    }
    Write-Host ""
}

# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------
@{
    Version = $ReleaseVersion
    InstallDir = $InstallDir
    AllUsers = $AllUsersBool
    Port = [int]$Port
    DbPath = if ($DbPath) { $DbPath } else { "owon_meter.duckdb" }
    ServiceCreated = $CreateServiceBool
    ServiceName = $ServiceName
    AutoStartCreated = $AutoStartBool
    ShortcutFolderPath = $ShortcutFolderPath
    InstalledAt = (Get-Date).ToString("o")
} | ConvertTo-Json | Set-Content -Path $ManifestPath -Encoding utf8

# ---------------------------------------------------------------------------
# Start it now and verify
# ---------------------------------------------------------------------------
Write-Step "Starting the app"
if ($CreateServiceBool) {
    Start-Service -Name $ServiceName
} else {
    Start-Process -FilePath $VenvPython -ArgumentList "run_prod.py" -WorkingDirectory $BackendInstallDir -WindowStyle Hidden -PassThru |
        ForEach-Object { @{ BackendPid = $_.Id } | ConvertTo-Json | Set-Content -Path $PidFilePath -Encoding utf8 }
}

$HealthUrl = "http://127.0.0.1:$Port/docs"
$deadline = (Get-Date).AddSeconds(60)
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
    Write-Host "$AppTitle v$ReleaseVersion is installed and running." -ForegroundColor Green
} else {
    Write-Host "Installed, but the app didn't respond within 60 seconds -- check for errors above." -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Open it at:  http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host ""
if ($CreateServiceBool) {
    Write-Host "It runs as a Windows Service ('$ServiceName') -- manage it via services.msc, or:" -ForegroundColor Cyan
    Write-Host "  Start-Service $ServiceName"
    Write-Host "  Stop-Service $ServiceName"
} elseif ($CreateShortcutBool) {
    Write-Host "Start Menu folder created: '$AppTitle'" -ForegroundColor Green
    Write-Host "  Start app             -- (re)starts it"
    Write-Host "  Stop app              -- stops it"
    Write-Host "  Upgrade or uninstall  -- re-runs this installer against the current install"
} else {
    $UpgradeCommand = "irm https://raw.githubusercontent.com/$GitHubOwner/$GitHubRepo/master/install.ps1 | iex"
    Write-Host "No Start Menu shortcuts were created. To (re)start, stop, upgrade, or uninstall later, run:" -ForegroundColor Cyan
    Write-Host "  Start:               powershell -ExecutionPolicy Bypass -File `"$StartScriptPath`""
    Write-Host "  Stop:                powershell -ExecutionPolicy Bypass -File `"$StopScriptPath`""
    Write-Host "  Upgrade/Uninstall:   powershell -ExecutionPolicy Bypass -Command `"$UpgradeCommand`""
}
Write-Host "===============================================" -ForegroundColor Cyan
