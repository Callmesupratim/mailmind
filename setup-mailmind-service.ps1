#Requires -RunAsAdministrator
# ── Mailmind → NSSM Windows service setup ───────────────────────────────────────
# Run from an ELEVATED PowerShell:  powershell -ExecutionPolicy Bypass -File .\setup-mailmind-service.ps1
# Safe to re-run: it removes and recreates the service cleanly.

$ErrorActionPreference = 'Stop'

$ServiceName = 'Mailmind'
$ProjectDir  = 'C:\Users\supra\Videos\mailmind'
$NodeExe     = 'C:\Program Files\nodejs\node.exe'
$ScriptArg   = 'server\index.js'
$LogDir      = Join-Path $ProjectDir 'logs'
$Port        = 3000

Write-Host '== Mailmind service setup ==' -ForegroundColor Cyan

# 1. Sanity checks
if (-not (Test-Path $NodeExe))                 { throw "node.exe not found at $NodeExe" }
if (-not (Test-Path (Join-Path $ProjectDir $ScriptArg))) { throw "server script not found in $ProjectDir" }

# 2. Ensure NSSM is installed (via Chocolatey if missing)
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
  Write-Host 'NSSM not found - installing via Chocolatey...' -ForegroundColor Yellow
  choco install nssm -y
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  $nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
  if (-not $nssm) { throw 'NSSM install failed - install manually from https://nssm.cc/download' }
}
Write-Host "Using NSSM: $nssm"

# 3. Remove existing service if present (makes this script re-runnable)
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "Removing existing '$ServiceName' service..."
  & nssm stop   $ServiceName confirm | Out-Null
  & nssm remove $ServiceName confirm | Out-Null
  Start-Sleep -Seconds 2
}

# 4. Free the port (kill any stray node listening on it)
$pid3000 = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
           Select-Object -First 1 -ExpandProperty OwningProcess
if ($pid3000) { Stop-Process -Id $pid3000 -Force; Write-Host "Freed port $Port (killed PID $pid3000)" }

# 5. Logs directory
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# 6. Create and configure the service
& nssm install $ServiceName $NodeExe $ScriptArg
& nssm set $ServiceName AppDirectory   $ProjectDir
& nssm set $ServiceName DisplayName    'Mailmind AI Email Assistant'
& nssm set $ServiceName Description     'Gmail-connected AI email assistant (Node/Express on port 3000)'
& nssm set $ServiceName Start           SERVICE_AUTO_START
& nssm set $ServiceName AppStdout       (Join-Path $LogDir 'service-out.log')
& nssm set $ServiceName AppStderr       (Join-Path $LogDir 'service-err.log')
& nssm set $ServiceName AppRotateFiles  1
& nssm set $ServiceName AppRotateBytes  1048576
& nssm set $ServiceName AppExit Default Restart

# 7. Start it
& nssm start $ServiceName
Start-Sleep -Seconds 3
Write-Host ("Service status: " + (& nssm status $ServiceName))

# 8. Verify HTTP
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/auth/status" -TimeoutSec 5
  Write-Host "HTTP $($r.StatusCode): $($r.Content)" -ForegroundColor Green
  Write-Host "Mailmind is running as a service at http://localhost:$Port" -ForegroundColor Green
} catch {
  Write-Host "Service registered but HTTP check failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Check logs in: $LogDir"
}
