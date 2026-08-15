# Local CI gate: runs the same checks as .github/workflows
param(
  [switch]$Fast
)

$ErrorActionPreference = 'Stop'

function Invoke-Step {
  param(
    [string]$Name,
    [string]$Command
  )

  Write-Host "==> $Name" -ForegroundColor Cyan
  & cmd /c $Command
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAILED: $Name" -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

Invoke-Step -Name 'format:check' -Command 'npm run format:check'
Invoke-Step -Name 'lint' -Command 'npm run lint'
Invoke-Step -Name 'typecheck' -Command 'npm run typecheck'
Invoke-Step -Name 'test' -Command 'npm test'

if (-not $Fast) {
  Invoke-Step -Name 'homey app validate' -Command 'npx homey app validate --level publish'
}

Write-Host 'All checks passed.' -ForegroundColor Green
