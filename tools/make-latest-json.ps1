<#
.SYNOPSIS
  Authors the latest.json manifest that installed copies of Sandwich poll for updates.

.DESCRIPTION
  The updater in every installed Sandwich fetches
    https://github.com/sepehrbayat/sandwich-download-manager/releases/latest/download/latest.json
  compares the version, verifies the artifact signature against the public key baked into the
  app, and offers the update. This script builds that manifest from a finished bundle.

  Run AFTER `tauri build` with TAURI_SIGNING_PRIVATE_KEY set, so the .sig exists. The
  manifest must be uploaded as a release asset named exactly latest.json — and every future
  release must include one, or older installs will stop hearing about updates.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/make-latest-json.ps1 -Version 0.3.0
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Repo = "sepehrbayat/sandwich-download-manager",
  [string]$Notes = ""
)

$ErrorActionPreference = "Stop"
$bundle = Join-Path $PSScriptRoot "..\target\release\bundle\nsis"
$setup = Join-Path $bundle "Sandwich Download Manager_${Version}_x64-setup.exe"
$sig = "$setup.sig"

if (-not (Test-Path $setup)) { throw "installer not found: $setup - build first" }
if (-not (Test-Path $sig)) { throw "signature not found: $sig - build with TAURI_SIGNING_PRIVATE_KEY set" }

# GitHub replaces spaces in asset names with dots; the URL must use the name it will serve.
$assetName = (Split-Path $setup -Leaf).Replace(" ", ".")

$manifest = [ordered]@{
  version = $Version
  notes = $Notes
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      # The signature is the .sig file's CONTENT, not a path or URL.
      signature = (Get-Content $sig -Raw).Trim()
      url = "https://github.com/$Repo/releases/download/v$Version/$assetName"
    }
  }
}

$out = Join-Path $bundle "latest.json"
# Not Set-Content: under Windows PowerShell 5.1 its UTF8 writes a BOM, and serde_json —
# which every installed copy parses this file with — rejects a manifest that starts with
# one. That is an updater outage that no local Get-Content check can see, because
# Get-Content strips the BOM back out on read.
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path (Resolve-Path $bundle) "latest.json"), $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "wrote $out"
Write-Host "  version : $Version"
Write-Host "  url     : $($manifest.platforms.'windows-x86_64'.url)"
