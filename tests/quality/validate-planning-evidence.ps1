[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
)

$ErrorActionPreference = "Stop"
$requestId = "DEVREQ-CYCLE-EVT-20260803-001"
$planId = "ENGPLAN-CYCLE-EVT-20260803-001"
$requiredRecords = @(
    "docs/architecture/$requestId-solution-architecture.json",
    "docs/backend-api-integration/$requestId-backend-api-integration-review.json",
    "docs/client-applications/$requestId-client-applications-review.json",
    "docs/data-analytics-ai/$requestId-data-analytics-ai-review.json",
    "docs/database-storage/$requestId-database-storage-plan.json",
    "docs/developer-experience-delivery/$requestId-developer-experience-delivery-plan.json",
    "docs/engineering-coordination/$requestId-workstream-sequence.json",
    "docs/frontend-accessibility/$requestId-frontend-accessibility-review.json",
    "docs/platform-cloud-network/$requestId-platform-cloud-network-review.json",
    "docs/security-privacy-compliance/$requestId-security-privacy-compliance-review.json",
    "docs/seo-web-discovery/$requestId-technical-seo-assessment.json",
    "docs/sre-observability-performance/$requestId-sre-observability-performance-plan.json"
)

$failures = [System.Collections.Generic.List[string]]::new()
$checks = [System.Collections.Generic.List[object]]::new()

function Add-Check([string]$Name, [bool]$Passed, [string]$Evidence) {
    $checks.Add([ordered]@{ name = $Name; passed = $Passed; evidence = $Evidence })
    if (-not $Passed) { $failures.Add("${Name}: ${Evidence}") }
}

$records = @{}
foreach ($relativePath in $requiredRecords) {
    $fullPath = Join-Path $RepositoryRoot $relativePath
    $exists = Test-Path -LiteralPath $fullPath -PathType Leaf
    Add-Check "record-exists:$relativePath" $exists $(if ($exists) { "present" } else { "missing" })
    if (-not $exists) { continue }

    try {
        $record = Get-Content -LiteralPath $fullPath -Raw | ConvertFrom-Json -Depth 100
        $records[$relativePath] = $record
        Add-Check "json-valid:$relativePath" $true "parsed"
        Add-Check "request-trace:$relativePath" ($record.requestId -eq $requestId) "requestId=$($record.requestId)"
        Add-Check "plan-trace:$relativePath" ($record.planId -eq $planId) "planId=$($record.planId)"
    }
    catch {
        Add-Check "json-valid:$relativePath" $false $_.Exception.Message
    }
}

$architecturePath = $requiredRecords[0]
if ($records.ContainsKey($architecturePath)) {
    $architecture = $records[$architecturePath]
    $domain = @($architecture.componentTopology | Where-Object { $_.component -eq "Download domain" })
    Add-Check "shared-domain-owner" ($domain.Count -eq 1 -and $domain[0].kind -eq "shared") "Download domain entries=$($domain.Count); kind=$($domain[0].kind)"
    Add-Check "architecture-not-approved" ($architecture.status -match "blocked|proposed") "status=$($architecture.status)"
    Add-Check "independent-verifier-reserved" ($architecture.decisionAuthority.independentVerifier -eq "ENG-15") "independentVerifier=$($architecture.decisionAuthority.independentVerifier)"
}

$allText = ($records.Values | ConvertTo-Json -Depth 100 -Compress)
foreach ($behavior in @("queued", "active", "paused", "cancelled", "failed", "interrupted", "completed")) {
    Add-Check "state-trace:$behavior" ($allText -match ('"' + [regex]::Escape($behavior) + '"')) "state appears in planning evidence"
}

$result = [ordered]@{
    schemaVersion = "1.0.0"
    requestId = $requestId
    planId = $planId
    suite = "planning-evidence-contract"
    status = $(if ($failures.Count -eq 0) { "passed" } else { "failed" })
    recordsInspected = $records.Count
    checks = $checks
    failures = $failures
}

$result | ConvertTo-Json -Depth 100
if ($failures.Count -gt 0) { exit 1 }
