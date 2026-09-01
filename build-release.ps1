<#
  Packages a versioned release .zip: builds the frontend once, stages backend
  source (excluding dev-only/runtime-generated files) plus the prebuilt
  frontend/dist, and zips the result. This is the artifact install.ps1
  downloads and installs -- shipping frontend/dist prebuilt means a target
  machine never needs Node.js at install time, only Python.

  The staged layout deliberately mirrors this repo's own structure
  (<root>/backend/app/... next to <root>/frontend/dist/...) because
  backend/app/static_site.py locates the built frontend relative to itself
  (three parents up, then frontend/dist) -- so the same relative path works
  whether <root> is this repo checkout or an installed copy.

  Usage (from repo root):
    powershell -ExecutionPolicy Bypass -File .\build-release.ps1
#>

$ErrorActionPreference = "Stop"

$RepoRoot    = $PSScriptRoot
$BackendDir  = Join-Path $RepoRoot "backend"
$FrontendDir = Join-Path $RepoRoot "frontend"

$pkg = Get-Content (Join-Path $FrontendDir "package.json") -Raw | ConvertFrom-Json
$Version = $pkg.version
if (-not $Version) {
    throw "Couldn't read a version from frontend/package.json"
}

$ReleaseName = "owon-suite-v$Version"
$StagingDir  = Join-Path $RepoRoot "release-staging\$ReleaseName"
$ZipPath     = Join-Path $RepoRoot "$ReleaseName.zip"

Write-Host "== Building frontend (npm ci && npm run build) ==" -ForegroundColor Cyan
Push-Location $FrontendDir
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit code $LASTEXITCODE)" }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit code $LASTEXITCODE)" }
} finally {
    Pop-Location
}

if (Test-Path $StagingDir) { Remove-Item $StagingDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null

Write-Host "== Staging backend source ==" -ForegroundColor Cyan
$BackendStage = Join-Path $StagingDir "backend"
New-Item -ItemType Directory -Force -Path $BackendStage | Out-Null

# app/ (the whole application package) copied wholesale minus __pycache__.
Copy-Item -Path (Join-Path $BackendDir "app") -Destination (Join-Path $BackendStage "app") -Recurse
Get-ChildItem -Path (Join-Path $BackendStage "app") -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force

# Entry point + pinned deps only -- deliberately NOT requirements.txt
# (unpinned, dev-only), NOT config.env (installer-generated, never shipped),
# and NOT the .venv/owon_meter.duckdb*/certs runtime artifacts that live
# alongside these in a working dev checkout.
Copy-Item -Path (Join-Path $BackendDir "run_prod.py") -Destination $BackendStage
Copy-Item -Path (Join-Path $BackendDir "requirements-lock.txt") -Destination $BackendStage

Write-Host "== Staging prebuilt frontend ==" -ForegroundColor Cyan
$FrontendDist = Join-Path $FrontendDir "dist"
if (-not (Test-Path $FrontendDist)) {
    throw "frontend/dist not found after build -- did npm run build produce output?"
}
Copy-Item -Path $FrontendDist -Destination (Join-Path $StagingDir "frontend\dist") -Recurse

Write-Host "== Zipping $ReleaseName.zip ==" -ForegroundColor Cyan
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path (Join-Path $StagingDir "*") -DestinationPath $ZipPath

Remove-Item (Join-Path $RepoRoot "release-staging") -Recurse -Force

Write-Host ""
Write-Host "Release package: $ZipPath" -ForegroundColor Green
Write-Host "Attach this file to a GitHub Release (tag v$Version) so install.ps1 can find it." -ForegroundColor Yellow
