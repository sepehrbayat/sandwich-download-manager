<#
.SYNOPSIS
  Exercises an installed Sandwich against the real network and reports what actually works.

.DESCRIPTION
  The unit and UI suites test the pieces. This tests the assembled product the way a user
  meets it: launch the installed binary, move real bytes, pause and resume mid-transfer, hand
  a download over from the browser bridge, and confirm nothing is left running afterwards.

  Every bug that reached a user in this project's first day was an integration failure of
  exactly this kind — a dead event bridge, a stale asset bundle, an orphaned engine — and none
  of them were reachable by the other suites.

  Safe to run on a working machine: it uses its own filenames, removes only what it created,
  and never touches existing downloads, settings or the queue.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tests/quality/smoke-installed.ps1
#>
[CmdletBinding()]
param(
  [string]$AppPath = "$env:LOCALAPPDATA\Sandwich Download Manager\sandwich-desktop.exe",
  [string]$BridgePath = "",
  # Roughly 31 MB, and reliably available.
  [string]$SmallUrl = "https://wordpress.org/latest.zip",
  # Large enough that a pause lands mid-transfer rather than after completion.
  [string]$LargeUrl = "https://releases.ubuntu.com/24.04/ubuntu-24.04.4-desktop-amd64.iso"
)

$ErrorActionPreference = "Stop"
$script:failures = 0
$script:created = @()
$prefix = "sandwich-smoke"

function Check($name, $ok, $detail = "") {
  $mark = if ($ok) { "PASS" } else { "FAIL"; }
  if (-not $ok) { $script:failures++ }
  $line = "  [{0}] {1}" -f $mark, $name
  if ($detail) { $line += "  ($detail)" }
  Write-Host $line -ForegroundColor $(if ($ok) { "Green" } else { "Red" })
}

function Section($title) { Write-Host "`n$title" -ForegroundColor Cyan }

# --- engine access -----------------------------------------------------------------------

function Handoff {
  $path = Join-Path $env:APPDATA "dev.sandwich.download-manager\engine.json"
  if (-not (Test-Path $path)) { return $null }
  Get-Content $path -Raw | ConvertFrom-Json
}

function Rpc($handoff, $method, [object[]]$rest) {
  $params = New-Object System.Collections.ArrayList
  [void]$params.Add("token:$($handoff.secret)")
  foreach ($item in $rest) { [void]$params.Add($item) }
  $body = @{ jsonrpc = "2.0"; id = "smoke"; method = $method; params = $params } |
          ConvertTo-Json -Depth 10 -Compress
  try {
    (Invoke-RestMethod -Uri $handoff.endpoint -Method Post -ContentType "application/json" -Body $body).result
  } catch {
    $null
  }
}

function Queue($handoff, $url, $name) {
  $script:created += $name
  # params must be [token, [uris], {options}]. Passing that through a [object[]] parameter
  # flattens the nested URI array into the options object, so build it here as an ArrayList.
  $params = New-Object System.Collections.ArrayList
  [void]$params.Add("token:$($handoff.secret)")
  [void]$params.Add(@($url))
  [void]$params.Add(@{ out = $name })
  $body = @{ jsonrpc = "2.0"; id = "queue"; method = "aria2.addUri"; params = $params } |
          ConvertTo-Json -Depth 10 -Compress
  try {
    (Invoke-RestMethod -Uri $handoff.endpoint -Method Post -ContentType "application/json" -Body $body).result
  } catch {
    $null
  }
}

# Where a queued download is actually being written, or $null if it is not known yet.
function OutputPath($handoff, $gid) {
  $status = Rpc $handoff "aria2.tellStatus" @($gid)
  if (-not $status -or -not $status.files -or $status.files.Count -eq 0) { return $null }
  $status.files[0].path
}

function Cleanup($handoff) {
  foreach ($item in @(Rpc $handoff "aria2.tellActive" @())) {
    if (-not $item.files -or $item.files.Count -eq 0) { continue }
    if ($script:created -contains $item.files[0].path.Split('/\')[-1]) {
      Rpc $handoff "aria2.forceRemove" @($item.gid) | Out-Null
    }
  }
  Start-Sleep -Milliseconds 500
  # By prefix, not by exact name: when a file already exists aria2 renames the newcomer to
  # name.1.ext, which "name.ext*" never matches. One survivor then poisons the next run —
  # its partial makes "progress" look instant and resume measurements meaningless.
  Remove-Item (Join-Path $env:USERPROFILE "Downloads\$prefix*") -Force -ErrorAction SilentlyContinue
}

# --- run ---------------------------------------------------------------------------------

Write-Host "Sandwich installed-build smoke test" -ForegroundColor White
Write-Host "app: $AppPath"

if (-not (Test-Path $AppPath)) {
  Write-Host "  [FAIL] the application is not installed at that path" -ForegroundColor Red
  exit 1
}

Section "Startup"
# A previous run that died mid-way leaves partials behind; measuring against them makes
# this run lie in both directions. Start from a clean plate.
Remove-Item (Join-Path $env:USERPROFILE "Downloads\$prefix*") -Force -ErrorAction SilentlyContinue
Get-Process -Name sandwich-desktop -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }
Start-Sleep -Seconds 2

$enginePath = Join-Path (Split-Path $AppPath) "binaries\aria2c.exe"
Check "the bundled engine exists" (Test-Path $enginePath) $enginePath
if (Test-Path $enginePath) {
  $engineVersion = @(& $enginePath --version 2>&1)
  Check "the bundled engine is executable" ($LASTEXITCODE -eq 0) $engineVersion[0]
}

$appStdout = Join-Path $env:TEMP "sandwich-smoke-app-out.log"
$appStderr = Join-Path $env:TEMP "sandwich-smoke-app-error.log"
Remove-Item $appStdout, $appStderr -Force -ErrorAction SilentlyContinue
Start-Process $AppPath -RedirectStandardOutput $appStdout -RedirectStandardError $appStderr | Out-Null

# Readiness is the contract, not an arbitrary sleep. A clean Windows machine can hold a newly
# installed sidecar for several seconds while antivirus inspects it, so allow the app's bounded
# startup window and stop as soon as both the engine and browser handoff are real.
$deadline = (Get-Date).AddSeconds(25)
do {
  Start-Sleep -Milliseconds 500
  $engines = @(Get-CimInstance Win32_Process -Filter "Name='aria2c.exe'" | Where-Object { $_.CommandLine -match 'rpc-secret' })
  $handoff = Handoff
} until (($engines.Count -eq 1 -and $null -ne $handoff) -or (Get-Date) -ge $deadline)

$app = @(Get-Process -Name sandwich-desktop -ErrorAction SilentlyContinue)
Check "the application starts" ($app.Count -eq 1) "$($app.Count) process(es)"
if ($app.Count -eq 0) { exit 1 }
Check "it opens a window" ([bool]$app[0].MainWindowTitle) $app[0].MainWindowTitle

Check "exactly one engine is running" ($engines.Count -eq 1) "$($engines.Count) engine(s)"

$engineFromBundle = $engines.Count -gt 0 -and $engines[0].CommandLine -match [regex]::Escape("Sandwich Download Manager")
Check "the engine is the bundled copy" $engineFromBundle

Check "the browser handoff is published" ($null -ne $handoff) $(if ($handoff) { $handoff.endpoint })
if (-not $handoff) {
  Get-Process -Name sandwich-desktop -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }
  Start-Sleep -Seconds 1
  if (Test-Path $appStderr) {
    Write-Host "`nApplication stderr:" -ForegroundColor Yellow
    Get-Content $appStderr
  }
  exit 1
}

Section "A second launch must not start a second engine"
Start-Process $AppPath | Out-Null
Start-Sleep -Seconds 6
$apps = @(Get-Process -Name sandwich-desktop -ErrorAction SilentlyContinue)
$engines = @(Get-CimInstance Win32_Process -Filter "Name='aria2c.exe'" | Where-Object { $_.CommandLine -match 'rpc-secret' })
Check "still a single application" ($apps.Count -eq 1) "$($apps.Count)"
Check "still a single engine" ($engines.Count -eq 1) "$($engines.Count)"

Section "Transfer"
$gid = Queue $handoff $SmallUrl "$prefix-small.zip"
Check "a download can be queued" ([bool]$gid) $gid
if ($gid) {
  $done = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 2
    $status = Rpc $handoff "aria2.tellStatus" @($gid)
    if ($status.status -eq "complete") { $done = $true; break }
    if ($status.status -eq "error") { break }
  }
  Check "it completes" $done "$([math]::Round([int64]$status.completedLength/1MB,1))MB"
  $onDisk = Test-Path (Join-Path $env:USERPROFILE "Downloads\$prefix-small.zip")
  Check "the file is on disk" $onDisk
}

Section "Pause, resume and cancel"
$big = Queue $handoff $LargeUrl "$prefix-large.iso"
if ($big) {
  Start-Sleep -Seconds 8
  $running = Rpc $handoff "aria2.tellStatus" @($big)
  Check "a large transfer is moving" ([int64]$running.completedLength -gt 0) `
        "$([math]::Round([int64]$running.completedLength/1MB,1))MB over $($running.connections) connections"

  Rpc $handoff "aria2.pause" @($big) | Out-Null
  Start-Sleep -Seconds 3
  $held = [int64](Rpc $handoff "aria2.tellStatus" @($big)).completedLength
  Start-Sleep -Seconds 4
  $after = Rpc $handoff "aria2.tellStatus" @($big)
  Check "pause actually stops the transfer" ([int64]$after.completedLength -eq $held) `
        "held at $([math]::Round($held/1MB,1))MB"

  Rpc $handoff "aria2.unpause" @($big) | Out-Null
  Start-Sleep -Seconds 7
  $resumed = Rpc $handoff "aria2.tellStatus" @($big)
  Check "resume continues from the pause point" ([int64]$resumed.completedLength -gt $held) `
        "$([math]::Round([int64]$resumed.completedLength/1MB,1))MB"

  Rpc $handoff "aria2.forceRemove" @($big) | Out-Null
  Start-Sleep -Seconds 2
  $still = @(Rpc $handoff "aria2.tellActive" @()) | Where-Object { $_.gid -eq $big }
  Check "cancel removes the transfer" ($still.Count -eq 0)
}

Section "Browser bridge"
if (-not $BridgePath) {
  foreach ($candidate in @(
    (Join-Path (Split-Path $AppPath) "binaries\sandwich-browser-host.exe"),
    (Join-Path (Split-Path $AppPath) "sandwich-browser-host.exe"),
    (Join-Path $PSScriptRoot "..\..\target\release\sandwich-browser-host.exe"),
    (Join-Path $PSScriptRoot "..\..\target\debug\sandwich-browser-host.exe")
  )) { if (Test-Path $candidate) { $BridgePath = (Resolve-Path $candidate).Path; break } }
}
if (-not (Test-Path $BridgePath)) {
  Check "the bridge binary exists" $false "not found; build with cargo build --workspace"
} else {
  # Native messaging framing: a little-endian length followed by that many bytes of JSON.
  # The frame is fed from a file rather than an in-process pipe because Windows PowerShell
  # 5.1 prepends a UTF-8 BOM to a child's stdin stream, which corrupts the length header;
  # a file redirect delivers exactly the bytes written and behaves the same on 5.1 and 7+.
  # Always returns an object, never $null, so a failed exchange reports why rather than
  # producing three silent FAILs that all look like the same unexplained problem.
  function Bridge($request) {
    $json = ($request | ConvertTo-Json -Depth 6 -Compress)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $frame = [BitConverter]::GetBytes([uint32]$bytes.Length) + $bytes
    $stdinFile = Join-Path $env:TEMP "sandwich-smoke-bridge-in.bin"
    $stdoutFile = Join-Path $env:TEMP "sandwich-smoke-bridge-out.bin"
    try {
      [System.IO.File]::WriteAllBytes($stdinFile, $frame)
      $proc = Start-Process -FilePath $BridgePath -RedirectStandardInput $stdinFile `
                -RedirectStandardOutput $stdoutFile -NoNewWindow -PassThru
      if (-not $proc.WaitForExit(15000)) { $proc.Kill(); }
      $raw = [System.IO.File]::ReadAllBytes($stdoutFile)
      if ($raw.Length -lt 5) {
        return [pscustomobject]@{ ok = $false; gid = $null; error = "the bridge answered nothing (exit $($proc.ExitCode))" }
      }
      [System.Text.Encoding]::UTF8.GetString($raw, 4, $raw.Length - 4) | ConvertFrom-Json
    } finally {
      Remove-Item $stdinFile, $stdoutFile -Force -ErrorAction SilentlyContinue
    }
  }

  # Reads better at the call site than repeating the conditional in every Check.
  function Detail($response) { if ($response.ok) { $response.gid } else { $response.error } }

  $ok = Bridge @{ url = $SmallUrl; filename = "$prefix-bridge.zip"; referrer = "https://wordpress.org/"; user_agent = "Mozilla/5.0"; cookie = "session=test" }
  $script:created += "$prefix-bridge.zip"
  Check "the browser can hand over a download" ($ok.ok -eq $true) (Detail $ok)
  if ($ok.gid) { Rpc $handoff "aria2.forceRemove" @($ok.gid) | Out-Null }

  # The browser is an untrusted source of filenames: a hostile site chooses them.
  $escape = Bridge @{ url = "https://example.com/payload.zip"; filename = "..\..\..\Windows\System32\evil.dll" }
  $script:created += "evil.dll"
  $contained = $false
  if ($escape.gid) {
    $where = OutputPath $handoff $escape.gid
    $contained = $where -and ($where -notmatch "System32")
    Rpc $handoff "aria2.forceRemove" @($escape.gid) | Out-Null
  }
  Check "a traversal filename cannot escape the download folder" $contained (Detail $escape)

  # Checking the refusal *reason*, not just ok=false: a bridge that answered nothing at all
  # would otherwise pass this while failing everything else.
  $scheme = Bridge @{ url = "file:///C:/Windows/win.ini" }
  Check "a non-web URL is refused" ($scheme.ok -eq $false -and $scheme.error -match "HTTP") $scheme.error
}

Section "Shutdown"
Cleanup $handoff
Get-Process -Name sandwich-desktop -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }
Start-Sleep -Seconds 3
$orphans = @(Get-Process -Name aria2c -ErrorAction SilentlyContinue)
Check "the engine exits with the application" ($orphans.Count -eq 0) "$($orphans.Count) orphan(s)"
Remove-Item $appStdout, $appStderr -Force -ErrorAction SilentlyContinue

Write-Host ""
if ($script:failures -eq 0) {
  Write-Host "All checks passed." -ForegroundColor Green
  exit 0
}
Write-Host "$($script:failures) check(s) failed." -ForegroundColor Red
exit 1
