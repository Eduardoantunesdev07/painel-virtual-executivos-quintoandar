$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue

if (-not $listener) {
  Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory $projectRoot -WindowStyle Hidden
  $ready = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue) {
      $ready = $true
      break
    }
  }
  if (-not $ready) { throw 'O servidor do Painel RTx não iniciou.' }
}

Write-Host 'Painel RTx ativo em http://127.0.0.1:4173' -ForegroundColor Green
