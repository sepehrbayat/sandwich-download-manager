[CmdletBinding()]
param(
    [ValidateSet("Check", "Build")]
    [string]$Mode = "Check",

    [string]$ReportPath = (Join-Path ([System.IO.Path]::GetTempPath()) "sandwich-regression-report.json")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$startedAt = [DateTimeOffset]::UtcNow
$status = "failed"
$exitCode = 1

try {
    & (Join-Path $PSScriptRoot "verify-windows-delivery.ps1") -Mode $Mode
    if ($LASTEXITCODE -ne 0) {
        throw "Windows delivery verification failed with exit code $LASTEXITCODE"
    }

    Push-Location $repositoryRoot
    try {
        & git diff --check
        if ($LASTEXITCODE -ne 0) {
            throw "git diff --check failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }

    $status = "passed"
    $exitCode = 0
} catch {
    Write-Error $_
} finally {
    $completedAt = [DateTimeOffset]::UtcNow
    $reportDirectory = Split-Path -Parent $ReportPath
    if ($reportDirectory -and -not (Test-Path -LiteralPath $reportDirectory)) {
        New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    }

    [ordered]@{
        schemaVersion = "1.0.0"
        requestId = "DEVREQ-CYCLE-EVT-20260803-002"
        status = $status
        mode = $Mode
        startedAt = $startedAt.ToString("o")
        completedAt = $completedAt.ToString("o")
        durationMilliseconds = [Math]::Round(($completedAt - $startedAt).TotalMilliseconds)
        suites = @(
            [ordered]@{ command = "npm test"; evidence = "Real Node runtime formatter and canonical-state tests" }
            [ordered]@{ command = "cargo test --manifest-path packages/download-engine/Cargo.toml --locked"; evidence = "Controlled HTTP server, filesystem, persistence, metrics, and filename-safety runtime tests" }
            [ordered]@{ command = "cargo check --manifest-path apps/desktop/Cargo.toml --locked"; evidence = "Windows Tauri adapter compiles against the shared engine" }
            [ordered]@{ command = "git diff --check"; evidence = "Repository patch whitespace validation" }
        )
        acceptanceCriteria = @("AC-02", "AC-12", "AC-13", "AC-25", "AC-29", "AC-30")
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding utf8

    Write-Host "Regression report: $ReportPath"
}

exit $exitCode
