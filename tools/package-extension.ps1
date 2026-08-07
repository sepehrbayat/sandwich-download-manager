<# Cross-platform packager wrapper for Windows contributors. #>
[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
& node (Join-Path $PSScriptRoot "package-extension.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
