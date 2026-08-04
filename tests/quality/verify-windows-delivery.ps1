[CmdletBinding()]
param(
    [ValidateSet("Check", "Build")]
    [string]$Mode = "Check"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Checked {
    param(
        [Parameter(Mandatory)]
        [string]$Executable,
        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    Write-Host "> $Executable $($Arguments -join ' ')"
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable failed with exit code $LASTEXITCODE"
    }
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Push-Location $repositoryRoot
try {
    Invoke-Checked "node" @("--version")
    Invoke-Checked "npm" @("--version")
    Invoke-Checked "rustc" @("--version")
    Invoke-Checked "cargo" @("--version")
    Invoke-Checked "npm" @("test")
    Invoke-Checked "cargo" @("fmt", "--manifest-path", "packages/download-engine/Cargo.toml", "--all", "--", "--check")
    Invoke-Checked "cargo" @("test", "--manifest-path", "packages/download-engine/Cargo.toml", "--locked")

    if ($Mode -eq "Build") {
        Invoke-Checked "cargo" @("build", "--manifest-path", "apps/desktop/Cargo.toml", "--locked")
    } else {
        Invoke-Checked "cargo" @("check", "--manifest-path", "apps/desktop/Cargo.toml", "--locked")
    }
} finally {
    Pop-Location
}
