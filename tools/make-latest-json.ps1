<#
.SYNOPSIS
  Authors the multi-platform latest.json manifest that installed copies poll for updates.

.DESCRIPTION
  Reads the updater artifacts produced by signed Tauri builds for Windows x64, Linux x64,
  and macOS Apple Silicon. Each platform entry embeds the CONTENT of its matching .sig file;
  a path or URL is not a valid Tauri signature.

  Run after all three CI artifacts have been downloaded into one directory. The manifest must
  be attached to every GitHub release as latest.json so older installs keep receiving updates.

.EXAMPLE
  pwsh -File tools/make-latest-json.ps1 -Version 0.6.1 -ArtifactRoot release-assets
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Repo = "sepehrbayat/sandwich-download-manager",
  [string]$Notes = "",
  [string]$ArtifactRoot = (Join-Path $PSScriptRoot "..\target\release\bundle"),
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path -LiteralPath $ArtifactRoot).Path

function OneArtifact([string]$pattern, [string]$label) {
  $matches = @(Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Name -like $pattern })
  if ($matches.Count -ne 1) {
    throw "expected exactly one $label matching '$pattern' under $root; found $($matches.Count)"
  }
  $matches[0]
}

function PlatformEntry([System.IO.FileInfo]$artifact, [string]$label) {
  $signaturePath = "$($artifact.FullName).sig"
  if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf)) {
    throw "missing $label updater signature: $signaturePath"
  }
  $signature = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
  if (-not $signature) { throw "$label updater signature is empty: $signaturePath" }

  # GitHub normalizes spaces in uploaded release-asset names to dots.
  $assetName = $artifact.Name.Replace(" ", ".")
  [ordered]@{
    signature = $signature
    url = "https://github.com/$Repo/releases/download/v$Version/$assetName"
  }
}

$windows = OneArtifact "*_${Version}_x64-setup.exe" "Windows NSIS updater"
$linux = OneArtifact "*_${Version}_amd64.AppImage" "Linux AppImage updater"
$macos = OneArtifact "*.app.tar.gz" "macOS app updater archive"

$manifest = [ordered]@{
  version = $Version
  notes = $Notes
  # Formatting must not inherit the machine's calendar (for example PersianCalendar), or the
  # manifest can advertise year 1405 while the release was actually built in 2026.
  pub_date = (Get-Date).ToUniversalTime().ToString(
    "yyyy-MM-ddTHH:mm:ssZ",
    [Globalization.CultureInfo]::InvariantCulture
  )
  platforms = [ordered]@{
    "windows-x86_64" = PlatformEntry $windows "Windows"
    "linux-x86_64" = PlatformEntry $linux "Linux"
    "darwin-aarch64" = PlatformEntry $macos "macOS"
  }
}

if (-not $OutputPath) { $OutputPath = Join-Path $root "latest.json" }
$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory | Out-Null
}

# Windows PowerShell 5.1 writes a UTF-8 BOM via Set-Content. serde_json rejects a manifest
# beginning with that BOM, so write UTF-8 without one explicitly on every operating system.
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($OutputPath, $json, [System.Text.UTF8Encoding]::new($false))

Write-Host "wrote $OutputPath"
Write-Host "  version          : $Version"
foreach ($platform in $manifest.platforms.Keys) {
  Write-Host "  $platform : $($manifest.platforms[$platform].url)"
}
