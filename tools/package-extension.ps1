<#
.SYNOPSIS
  Builds the store-submission zips for the browser extension.

.DESCRIPTION
  Chrome Web Store, Edge Add-ons and Firefox AMO all take the same MV3 package: the extension
  files, nothing else. register-host.ps1 stays out — it is an installer-side tool, and a store
  reviewer seeing a PowerShell script that writes registry keys inside an extension package
  would (rightly) balk. The zip must have manifest.json at its ROOT, not inside a folder,
  which is the single most common store-rejection mistake.

  Writes dist/sandwich-extension-<version>.zip, usable for all three stores.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/package-extension.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$extension = Join-Path $root "extension"
$dist = Join-Path $root "dist"

$manifest = Get-Content (Join-Path $extension "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version

# Only what the browser runs. Everything is enumerated rather than globbed so a stray file
# in the folder can never ride along into a store submission.
$files = @(
  "manifest.json",
  "background.js",
  "popup.html",
  "popup.js",
  "icon16.png",
  "icon32.png",
  "icon48.png",
  "icon128.png"
)

foreach ($file in $files) {
  if (-not (Test-Path (Join-Path $extension $file))) { throw "missing from extension/: $file" }
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null
$zip = Join-Path $dist "sandwich-extension-$version.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue

$staging = Join-Path $env:TEMP "sandwich-extension-staging"
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $staging | Out-Null
foreach ($file in $files) { Copy-Item (Join-Path $extension $file) $staging }

Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip
Remove-Item $staging -Recurse -Force

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host "wrote $zip ($size KB)"
Write-Host "  manifest version : $version"
Write-Host "  files            : $($files.Count)"
Write-Host ""
Write-Host "Submit the SAME zip to:"
Write-Host "  Chrome Web Store : https://chrome.google.com/webstore/devconsole"
Write-Host "  Edge Add-ons     : https://partner.microsoft.com/dashboard/microsoftedge"
Write-Host "  Firefox AMO      : https://addons.mozilla.org/developers/"
Write-Host "Listing copy and permission justifications: extension/STORE.md"
