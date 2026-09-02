<#
  Uninstalls Suite for OWON Devices. Placed in the install folder by
  install.ps1 during every install -- self-contained, reads everything it
  needs from install-manifest.json sitting next to it (also written by
  install.ps1), so it needs no parameters.

  Also invoked internally by install.ps1 itself when you choose "Remove
  this installation" from the existing-install menu, rather than
  duplicating this logic there.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#>

$ErrorActionPreference = "Stop"

$InstallDir = $PSScriptRoot

# Windows refuses to delete a directory that's any running process's current
# working directory -- including this one, since the "Upgrade or Uninstall"
# shortcut launches PowerShell with its working directory set to $InstallDir
# itself. Move out of it before anything below tries to remove it (all path
# use elsewhere in this script is already absolute, so this has no other
# effect).
Set-Location $env:TEMP

$ManifestPath = Join-Path $InstallDir "install-manifest.json"

if (-not (Test-Path $ManifestPath)) {
    Write-Host "No install-manifest.json found next to this script -- this doesn't look like a valid Suite for OWON Devices install folder ($InstallDir)." -ForegroundColor Red
    exit 1
}
$Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json

function Stop-ProcessTree {
    param([int]$RootId)
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$RootId" -ErrorAction SilentlyContinue
    foreach ($child in $children) { Stop-ProcessTree -RootId $child.ProcessId }
    try { Stop-Process -Id $RootId -Force -ErrorAction Stop; Write-Host "  stopped PID $RootId" } catch {}
}

function Test-AppRunning {
    if ($Manifest.ServiceCreated) {
        $svc = Get-Service -Name $Manifest.ServiceName -ErrorAction SilentlyContinue
        return [bool]($svc -and $svc.Status -eq 'Running')
    }
    $PidFile = Join-Path $InstallDir "owon-pids.json"
    if (-not (Test-Path $PidFile)) { return $false }
    $prev = Get-Content $PidFile -Raw | ConvertFrom-Json
    if (-not $prev.BackendPid) { return $false }
    return $null -ne (Get-Process -Id $prev.BackendPid -ErrorAction SilentlyContinue)
}

Write-Host "===============================================" -ForegroundColor Cyan
Write-Host " Uninstalling Suite for OWON Devices v$($Manifest.Version)" -ForegroundColor Cyan
Write-Host " Installed at: $InstallDir" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ""

if (Test-AppRunning) {
    Write-Host "Suite for OWON Devices is currently running -- it needs to be stopped to continue." -ForegroundColor Yellow
    $stopAnswer = Read-Host "Stop it now? (Y/n)"
    if ($stopAnswer -match '^[nN]') {
        Write-Host "Cancelled -- the app is still running, no changes were made." -ForegroundColor Cyan
        exit 0
    }
}

Write-Host "== Stopping the app ==" -ForegroundColor Cyan
if ($Manifest.ServiceCreated) {
    $NssmPath = Join-Path $InstallDir "nssm.exe"
    try {
        Stop-Service -Name $Manifest.ServiceName -Force -ErrorAction SilentlyContinue
        if (Test-Path $NssmPath) {
            & $NssmPath remove $Manifest.ServiceName confirm | Out-Null
        } else {
            sc.exe delete $Manifest.ServiceName | Out-Null
        }
        Write-Host "  removed Windows Service '$($Manifest.ServiceName)'"
    } catch {
        Write-Host "  couldn't fully remove the service (it may need manual removal via services.msc): $($_.Exception.Message)" -ForegroundColor Yellow
    }
} else {
    $PidFile = Join-Path $InstallDir "owon-pids.json"
    if (Test-Path $PidFile) {
        $prev = Get-Content $PidFile -Raw | ConvertFrom-Json
        if ($prev.BackendPid) { Stop-ProcessTree -RootId $prev.BackendPid }
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
}

if ($Manifest.AutoStartCreated) {
    Unregister-ScheduledTask -TaskName "OwonSuite AutoStart" -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "  removed auto-start Scheduled Task"
}

Write-Host "== Removing shortcuts ==" -ForegroundColor Cyan
if ($Manifest.ShortcutFolderPath -and (Test-Path $Manifest.ShortcutFolderPath)) {
    Remove-Item $Manifest.ShortcutFolderPath -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  removed $($Manifest.ShortcutFolderPath)"
}

$UninstallRegRoot = if ($Manifest.AllUsers) { "HKLM:" } else { "HKCU:" }
$UninstallRegKey = Join-Path $UninstallRegRoot "Software\Microsoft\Windows\CurrentVersion\Uninstall\OwonSuite"
if (Test-Path $UninstallRegKey) {
    Remove-Item $UninstallRegKey -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  removed Programs & Features registration"
}

Write-Host ""
$answer = Read-Host "Delete the recorded measurement database too? This permanently removes all recordings. (y/N)"
$DeleteDb = $answer -match '^[yY]'

$DbPath = $Manifest.DbPath
if (-not [System.IO.Path]::IsPathRooted($DbPath)) {
    $DbPath = Join-Path $InstallDir "backend\$DbPath"
}
$DbInsideInstallDir = $DbPath.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)

Write-Host "== Removing files ==" -ForegroundColor Cyan
if ($DeleteDb) {
    Remove-Item $DbPath, "$DbPath.wal" -Force -ErrorAction SilentlyContinue
    if (-not $DbInsideInstallDir) {
        # All-users installs keep the DB in %ProgramData%\OwonSuite, outside
        # InstallDir -- clean that folder up too when the database is going.
        Remove-Item (Split-Path $DbPath -Parent) -Recurse -Force -ErrorAction SilentlyContinue
    }
    try {
        Remove-Item $InstallDir -Recurse -Force
        Write-Host "Removed $InstallDir" -ForegroundColor Green
    } catch {
        Write-Host "Most files were removed, but $InstallDir couldn't be fully deleted (likely this script's own file, still in use) -- close this window and delete the folder manually." -ForegroundColor Yellow
    }
} else {
    if ($DbInsideInstallDir) {
        Get-ChildItem $InstallDir -Force | Where-Object {
            $_.FullName -ne $DbPath -and $_.FullName -ne "$DbPath.wal"
        } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "Removed the app, kept your database at: $DbPath" -ForegroundColor Green
        Write-Host "(the rest of $InstallDir was left in place to hold it; delete it yourself once you're sure you won't reinstall)" -ForegroundColor Green
    } else {
        try {
            Remove-Item $InstallDir -Recurse -Force
        } catch {
            Write-Host "Most files were removed, but $InstallDir couldn't be fully deleted (likely this script's own file, still in use) -- close this window and delete the folder manually." -ForegroundColor Yellow
        }
        Write-Host "Removed the app. Your database was kept at: $DbPath" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "Uninstall complete." -ForegroundColor Cyan
