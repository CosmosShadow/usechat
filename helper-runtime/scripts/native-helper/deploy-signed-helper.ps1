# Deploy a signed Windows helper.exe to the local Shennian Helper install dir.
# @arch ../../docs/HELPER_RUNTIME.md
# @arch ../../docs/COPY_OUT_SOURCES.md
#
# Usage:
#   scp helper-signed.exe windows:helper-signed.exe
#   ssh windows powershell -NoProfile -ExecutionPolicy Bypass -File deploy-signed-helper.ps1 [-Src <path>] [-InstalledDir <path>]
#
# Defaults:
#   Src           = %USERPROFILE%\helper-signed.exe
#   InstalledDir  = %LOCALAPPDATA%\Programs\Shennian Helper\resources\wechat-channel\windows
#
# Requires: daemon stopped beforehand (`shennian stop`), otherwise the exe is locked.
param(
    [string]$Src = (Join-Path $env:USERPROFILE 'helper-signed.exe'),
    [string]$InstalledDir = (Join-Path $env:LOCALAPPDATA 'Programs\Shennian Helper\resources\wechat-channel\windows')
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Src)) { throw "Source exe not found: $Src" }
if (-not (Test-Path $InstalledDir)) { throw "Installed helper dir not found: $InstalledDir" }

$dst = Join-Path $InstalledDir 'shennian-wechat-channel-helper.exe'
$manifest = Join-Path $InstalledDir 'manifest.json'
if (-not (Test-Path $manifest)) { throw "manifest.json missing at $manifest" }

$newHash = (Get-FileHash -Algorithm SHA256 $Src).Hash.ToLower()
Write-Host "New helper sha256: $newHash"

Copy-Item -Force $Src $dst
$existing = Get-Content $manifest -Raw
$updated = [regex]::Replace($existing, '"sha256":\s*"[0-9a-fA-F]+"', ('"sha256": "' + $newHash + '"'))
$updated = [regex]::Replace($updated, '"signed":\s*false', '"signed": true')
$updated | Set-Content -NoNewline $manifest

Write-Host "--- updated manifest ---"
Get-Content $manifest -Raw

Write-Host "--- Authenticode signature check ---"
$sig = Get-AuthenticodeSignature $dst
Write-Host ("Status: {0}" -f $sig.Status)
Write-Host ("SignerCertificate: {0}" -f ($sig.SignerCertificate | ForEach-Object { $_.Subject }))
Write-Host ("TimeStamperCertificate: {0}" -f ($sig.TimeStamperCertificate | ForEach-Object { $_.Subject }))
if ($sig.Status -ne 'Valid') {
    throw "Signature is not Valid (Status=$($sig.Status)); Device Guard will reject this exe. Re-run sign-windows-helper.mjs."
}

Write-Host "Deployed. Run 'shennian start' then a real send to verify."
