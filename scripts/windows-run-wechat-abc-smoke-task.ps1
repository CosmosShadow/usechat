# @arch ../docs/ARCHITECTURE.md
# @test ../packages/core/src/__tests__/wechat-runtime.test.ts

param(
  [string]$RepoRoot,
  [string]$Chat = "ABC",
  [string]$TaskName = "UseChatWechatAbcSmoke",
  [string]$ScriptName = "wechat-abc-smoke.mjs",
  [string]$OutputDir,
  [string]$NodePath,
  [int]$WaitSeconds = 240
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if (-not $RepoRoot) {
  $RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)

if (-not $OutputDir) {
  $OutputDir = Join-Path $RepoRoot ".usechat-smoke\windows"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

if (-not $NodePath) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    $NodePath = $nodeCommand.Source
  } elseif (Test-Path "C:\nvm4w\nodejs\node.exe") {
    $NodePath = "C:\nvm4w\nodejs\node.exe"
  } else {
    $NodePath = "node"
  }
}

$runnerPath = Join-Path $OutputDir "run-wechat-abc-smoke.ps1"
$outputPath = Join-Path $OutputDir "summary.json"
$stderrPath = Join-Path $OutputDir "stderr.txt"
$logPath = Join-Path $OutputDir "task.log"
$scriptPath = Join-Path (Join-Path $RepoRoot "scripts") $ScriptName
if (-not (Test-Path $scriptPath)) {
  throw "Smoke script not found: $scriptPath"
}

Remove-Item -Force -ErrorAction SilentlyContinue `
  $outputPath, `
  "$outputPath.stdout", `
  $stderrPath, `
  $logPath

@"
`$ErrorActionPreference = "Continue"
`$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(`$false)
Set-Location "$RepoRoot"
"started=`$(Get-Date -Format o); session=`$env:SESSIONNAME; user=`$env:USERNAME" | Set-Content -Encoding UTF8 "$logPath"
& "$NodePath" "$scriptPath" --chat "$Chat" --out "$outputPath" > "$outputPath.stdout" 2> "$stderrPath"
`$exitCode = `$LASTEXITCODE
"exit=`$exitCode; ended=`$(Get-Date -Format o)" | Add-Content -Encoding UTF8 "$logPath"
exit `$exitCode
"@ | Set-Content -Encoding UTF8 $runnerPath

$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`""
schtasks /Create /TN $TaskName /TR $taskCommand /SC ONCE /ST 23:59 /F /IT | Out-Null
schtasks /Run /TN $TaskName | Out-Null

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $logPath) {
    $log = Get-Content $logPath -ErrorAction SilentlyContinue
    if ($log -match "exit=") { break }
  }
  Start-Sleep -Seconds 2
}

Write-Output "summary=$outputPath"
Write-Output "stderr=$stderrPath"
Write-Output "log=$logPath"
if (Test-Path $outputPath) {
  Get-Content $outputPath
} elseif (Test-Path "$outputPath.stdout") {
  Get-Content "$outputPath.stdout"
}

$exitCode = $null
if (Test-Path $logPath) {
  $exitLine = Get-Content $logPath -ErrorAction SilentlyContinue | Where-Object { $_ -match "^exit=" } | Select-Object -Last 1
  if ($exitLine -match "^exit=([-0-9]+);") {
    $exitCode = [int]$Matches[1]
  }
}
if ($null -eq $exitCode) {
  Write-Error "Smoke task did not finish before timeout: $TaskName"
  exit 124
}
if ($exitCode -ne 0) {
  exit $exitCode
}
