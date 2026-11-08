param(
  [string]$RepoPath = '',
  [switch]$StartEditor
)
$ErrorActionPreference = 'Stop'
if (!$RepoPath) { $RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
if (!(Test-Path -LiteralPath $RepoPath -PathType Container)) { throw "Repository not found: $RepoPath" }
Write-Host 'SE-04 owner preflight: NO secrets, NO file changes, NO tunnels'
Push-Location -LiteralPath $RepoPath
try {
  git --version
  bun --version
  Write-Host 'Current branch / commit SHA:'
  git branch --show-current
  git rev-parse HEAD
  Write-Host 'Working tree status (do not discard changes):'
  git status --short
  foreach ($relative in @('apps/editor/src/lib/mcp/McpPanel.svelte', 'apps/editor/src/lib/server/mcp-bff.ts', 'docs/stable/owner-handoff/SE-04.md')) {
    if (!(Test-Path -LiteralPath $relative)) { throw "SE-04 required file missing: $relative" }
    Write-Host "OK $relative"
  }
  if ($StartEditor) {
    Write-Host 'Starting local Editor at http://127.0.0.1:5175; stop with Ctrl+C'
    bun run dev
  } else {
    Write-Host 'Preflight only; run bun install --frozen-lockfile, bun run check, bun run build'
    Write-Host 'Optional: -StartEditor launches localhost only, with no remote tunnel.'
  }
} finally { Pop-Location }
