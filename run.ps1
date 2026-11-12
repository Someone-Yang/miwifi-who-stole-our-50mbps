# Start the MiWiFi dashboard (Windows PowerShell)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
$env:PYTHONIOENCODING = 'utf-8'

$Candidates = @()
if ($env:MIWIFI_PYTHON) { $Candidates += $env:MIWIFI_PYTHON }
$Candidates += @(
    (Join-Path $Root '.conda-env\python.exe')
    (Join-Path $Root '.venv\Scripts\python.exe')
    (Join-Path $env:USERPROFILE '.conda\envs\miwifi-dashboard\python.exe')
    'C:\ProgramData\miniconda3\envs\miwifi-dashboard\python.exe'
)

$Python = $null
foreach ($Candidate in $Candidates) {
    if (Test-Path $Candidate) {
        $Python = $Candidate
        break
    }
}

if (-not $Python) {
    $Cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($Cmd) { $Python = $Cmd.Source }
}

if (-not $Python) {
    Write-Host 'Python not found.' -ForegroundColor Yellow
    Write-Host 'Run: conda env create -f environment.yml'
    Write-Host '     conda activate miwifi-dashboard'
    Write-Host 'Then start this script again.'
    Read-Host 'Press Enter to exit'
    exit 1
}

$HasFlask = $false
try {
    & $Python -c "import flask" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $HasFlask = $true }
} catch {
    $HasFlask = $false
}

if (-not $HasFlask) {
    Write-Host 'Flask is not installed for this Python.' -ForegroundColor Yellow
    Write-Host 'Run: conda env create -f environment.yml'
    Write-Host '     conda activate miwifi-dashboard'
    Read-Host 'Press Enter to exit'
    exit 1
}

Write-Host "Python: $Python" -ForegroundColor Cyan
Write-Host "Project: $Root" -ForegroundColor Cyan
Write-Host 'Open http://127.0.0.1:5000/ in your browser.'
& $Python (Join-Path $Root 'app.py')
exit $LASTEXITCODE
