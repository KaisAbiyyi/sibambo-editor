[CmdletBinding()]
param(
  [string]$BuilderRoot = '',
  [string]$EvidenceDir = ('D:\projects\sibambo\outputs\se05-acceptance-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')),
  [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
if (-not $BuilderRoot) { $BuilderRoot = Join-Path $PSScriptRoot '..\..\..\sibambo-bomc-builder' }
$editorRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$builderPath = (Resolve-Path -LiteralPath $BuilderRoot).Path
$evidencePath = [IO.Path]::GetFullPath($EvidenceDir)
if ($evidencePath -notmatch '^D:\\') { throw 'Sibambo evidence, temp, browser and venv must be on D:.' }
if (Test-Path -LiteralPath $evidencePath) { throw 'Use a new EvidenceDir so previous evidence is preserved.' }
$pythonCommand = Get-Command $Python -All -CommandType Application -ErrorAction Stop | Where-Object { $_.Source -notlike '*\Microsoft\WindowsApps\*' } | Select-Object -First 1 -ExpandProperty Source
$bunCommand = Get-Command bun -All -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
if (-not $pythonCommand) { throw 'Use an installed Python 3.12+ executable with -Python; do not use the Microsoft Store alias.' }
New-Item -ItemType Directory -Path $evidencePath | Out-Null
$keys = @('TEMP','TMP','PIP_CACHE_DIR','PYTHONPYCACHEPREFIX','BUN_INSTALL_CACHE_DIR','PLAYWRIGHT_BROWSERS_PATH','SE05_BUILDER_ROOT','SE05_PYTHON','SE05_OUTPUT_ROOT')
$saved = @{}
foreach ($name in $keys) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
function Invoke-Checked([string]$Executable, [string[]]$Arguments, [string]$LogName) {
  $logPath = Join-Path $evidencePath $LogName
  $previousPreference = $ErrorActionPreference
  # Windows PowerShell 5.1 represents ordinary native stderr as ErrorRecord. Check the exit code.
  $ErrorActionPreference = 'Continue'
  try { & $Executable @Arguments *> $logPath; $resultCode = $LASTEXITCODE }
  finally { $ErrorActionPreference = $previousPreference }
  if ($resultCode -ne 0) { Get-Content -LiteralPath $logPath -Tail 35; throw "Step failed ($resultCode): $LogName" }
}
try {
  $env:TEMP = $evidencePath; $env:TMP = $evidencePath
  $env:PIP_CACHE_DIR = Join-Path $evidencePath 'pip-cache'
  $env:PYTHONPYCACHEPREFIX = Join-Path $evidencePath 'pycache'
  $env:BUN_INSTALL_CACHE_DIR = Join-Path $evidencePath 'bun-cache'
  $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $evidencePath 'playwright'
  $env:SE05_BUILDER_ROOT = $builderPath
  $env:SE05_OUTPUT_ROOT = Join-Path $evidencePath 'integration'
  Invoke-Checked $pythonCommand @('-c', 'import sys; assert sys.version_info >= (3,12), "Python 3.12+ required"') '01-python.log'
  Invoke-Checked $pythonCommand @('-m','venv',(Join-Path $evidencePath 'venv')) '02-venv.log'
  $env:SE05_PYTHON = Join-Path $evidencePath 'venv\Scripts\python.exe'
  Invoke-Checked $env:SE05_PYTHON @('-m','pip','install','--require-hashes','-r',(Join-Path $builderPath 'service\requirements.lock')) '03-requirements.log'
  Push-Location $editorRoot
  try {
    Invoke-Checked $bunCommand @('install','--frozen-lockfile') '04-bun.log'
    Invoke-Checked $bunCommand @('tooling/testing/generate-draft-validator.ts','--check') '05-schema.log'
    Invoke-Checked $bunCommand @('test','./apps/editor/unit/mcp','./apps/editor/unit/editor') '06-unit.log'
    Invoke-Checked $bunCommand @('run','check') '07-check.log'
    Invoke-Checked $bunCommand @('x','tsc','--project','packages/tsconfig.json') '08-packages.log'
    Invoke-Checked $bunCommand @('x','playwright','install','chromium') '09-browser-install.log'
    Invoke-Checked $bunCommand @('tooling/testing/run-se05.ts') '10-integration.log'
  } finally { Pop-Location }
  'SE05_RESULT=PASS' | Set-Content -LiteralPath (Join-Path $evidencePath 'result.txt') -Encoding UTF8
  Write-Output "SE05_RESULT=PASS; synthetic evidence: $evidencePath"
} catch {
  'SE05_RESULT=FAIL' | Set-Content -LiteralPath (Join-Path $evidencePath 'result.txt') -Encoding UTF8
  throw
} finally {
  foreach ($name in $keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
