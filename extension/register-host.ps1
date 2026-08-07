<#
  Registers the Sandwich native messaging host with Chrome, Edge and Firefox.

  Browsers only launch a native host that is registered under a per-user registry key pointing
  at a manifest, and the manifest names exactly which extensions may talk to it. That pairing
  is the security model: an arbitrary program cannot reach this host, and this host will not
  answer an arbitrary extension.

  Run without arguments after loading the extension unpacked, passing the ID the browser
  assigned it. Everything here is written under HKCU, so no administrator rights are needed
  and nothing is changed for other users.
#>
[CmdletBinding()]
param(
  # Chrome/Edge assign this when the extension is loaded; copy it from chrome://extensions.
  [string]$ChromeExtensionId = "",
  [string]$EdgeExtensionId = "",
  # Firefox uses the id declared in the manifest.
  [string]$FirefoxExtensionId = "sandwich@sandwich.dev",
  [string]$HostBinary = "",
  [switch]$Unregister
)

$ErrorActionPreference = "Stop"
$hostName = "dev.sandwich.download_manager"

function Resolve-HostBinary {
  if ($HostBinary -and (Test-Path $HostBinary)) { return (Resolve-Path $HostBinary).Path }
  # Where the installer puts it, then a plain-copy install, then a local build.
  $installed = Join-Path $env:LOCALAPPDATA "Sandwich Download Manager"
  $candidates = @(
    (Join-Path $installed "binaries\sandwich-browser-host.exe"),
    (Join-Path $installed "sandwich-browser-host.exe"),
    (Join-Path $PSScriptRoot "..\target\release\sandwich-browser-host.exe"),
    (Join-Path $PSScriptRoot "..\target\debug\sandwich-browser-host.exe")
  )
  foreach ($c in $candidates) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
  throw "Could not find sandwich-browser-host.exe. Install Sandwich, build it with 'cargo build --workspace', or pass -HostBinary."
}

$registryTargets = @(
  @{ Name = "Chrome";  Key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"; Manifest = "chrome" },
  @{ Name = "Edge";    Key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"; Manifest = "edge" },
  @{ Name = "Firefox"; Key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"; Manifest = "firefox" }
)

if ($Unregister) {
  foreach ($target in $registryTargets) {
    if (Test-Path $target.Key) { Remove-Item $target.Key -Recurse -Force; "unregistered $($target.Name)" }
  }
  return
}

$binary = Resolve-HostBinary
"host binary: $binary"

$manifestDir = Join-Path $env:APPDATA "dev.sandwich.download-manager"
New-Item -ItemType Directory -Force -Path $manifestDir | Out-Null

# Chromium and Firefox disagree about how allowed callers are named, so each gets its own
# manifest rather than one that is subtly wrong for both.
$chromeOrigins = @()
if ($ChromeExtensionId) { $chromeOrigins += "chrome-extension://$ChromeExtensionId/" }
$edgeOrigins = @()
if ($EdgeExtensionId) { $edgeOrigins += "chrome-extension://$EdgeExtensionId/" }
elseif ($ChromeExtensionId) { $edgeOrigins += "chrome-extension://$ChromeExtensionId/" }

$chromeManifest = [ordered]@{
  name = $hostName
  description = "Sandwich Download Manager browser bridge"
  path = $binary
  type = "stdio"
  allowed_origins = $chromeOrigins
}
$edgeManifest = [ordered]@{
  name = $hostName
  description = "Sandwich Download Manager browser bridge"
  path = $binary
  type = "stdio"
  allowed_origins = $edgeOrigins
}
$firefoxManifest = [ordered]@{
  name = $hostName
  description = "Sandwich Download Manager browser bridge"
  path = $binary
  type = "stdio"
  allowed_extensions = @($FirefoxExtensionId)
}

$chromePath = Join-Path $manifestDir "native-host-chromium.json"
$edgePath = Join-Path $manifestDir "native-host-edge.json"
$firefoxPath = Join-Path $manifestDir "native-host-firefox.json"
$chromeManifest | ConvertTo-Json -Depth 5 | Set-Content -Path $chromePath -Encoding UTF8
$edgeManifest | ConvertTo-Json -Depth 5 | Set-Content -Path $edgePath -Encoding UTF8
$firefoxManifest | ConvertTo-Json -Depth 5 | Set-Content -Path $firefoxPath -Encoding UTF8

foreach ($target in $registryTargets) {
  $manifest = switch ($target.Manifest) {
    "firefox" { $firefoxPath }
    "edge" { $edgePath }
    default { $chromePath }
  }
  New-Item -Path $target.Key -Force | Out-Null
  Set-ItemProperty -Path $target.Key -Name "(default)" -Value $manifest
  "registered $($target.Name) -> $manifest"
}

if (-not $ChromeExtensionId) {
  Write-Warning "Chrome is staged but disabled. Supply -ChromeExtensionId with its Chrome store/development ID."
}
if (-not $EdgeExtensionId) {
  Write-Warning "Edge is staged with the Chrome/development ID fallback. Supply -EdgeExtensionId before release."
}
