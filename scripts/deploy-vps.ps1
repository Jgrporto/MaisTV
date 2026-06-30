param(
  [Parameter(Mandatory = $true)]
  [string[]]$Files,
  [string]$SshHost = "root@89.117.32.226",
  [string]$RemoteRoot = "/root/SaasTV",
  [switch]$SkipBuild,
  [switch]$SkipRestart
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupRoot = "$RemoteRoot/.deploy-backups/$timestamp"

function Resolve-RelativePath {
  param([string]$InputPath)

  $absolutePath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $InputPath))
  if (-not $absolutePath.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Arquivo fora do repositorio: $InputPath"
  }
  if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
    throw "Arquivo nao encontrado: $InputPath"
  }
  return [System.IO.Path]::GetRelativePath($repoRoot, $absolutePath).Replace("\", "/")
}

$relativeFiles = $Files | ForEach-Object { Resolve-RelativePath $_ } | Select-Object -Unique
$frontendPaths = @("src/", "public/", "index.html", "vite.config.js", "tailwind.config.js", "postcss.config.js")
$localApiChanged = $relativeFiles | Where-Object { $_ -eq "server/local-api.mjs" }
$stackChanged = $relativeFiles | Where-Object {
  $_ -in @("server/whatsapp-server.js", "server/checkout-server.js", "server/painel-agent-broker.js", "server/start-all.js", "package.json", "package-lock.json")
}
$needsBuild = -not $SkipBuild -and ($relativeFiles | Where-Object {
  $path = $_
  $frontendPaths | Where-Object { $path.StartsWith($_) -or $path -eq $_ }
})

Write-Host "Backup remoto: $backupRoot"

foreach ($relativePath in $relativeFiles) {
  $remotePath = "$RemoteRoot/$relativePath"
  $remoteDir = Split-Path $remotePath -Parent
  $backupPath = "$backupRoot/$relativePath"
  $backupDir = Split-Path $backupPath -Parent

  ssh $SshHost "mkdir -p '$remoteDir' '$backupDir'; if [ -f '$remotePath' ]; then cp '$remotePath' '$backupPath'; fi"
  scp "$repoRoot\$($relativePath.Replace('/', '\'))" "${SshHost}:$remotePath" | Out-Null
  Write-Host "Enviado: $relativePath"
}

if ($needsBuild) {
  Write-Host "Executando build remoto"
  ssh $SshHost "cd '$RemoteRoot' && npm run build"
}

if (-not $SkipRestart) {
  if ($stackChanged) {
    Write-Host "Reiniciando tv-assist-whatsapp.service"
    ssh $SshHost "systemctl restart tv-assist-whatsapp.service && systemctl is-active tv-assist-whatsapp.service"
  }
  if ($localApiChanged) {
    Write-Host "Reiniciando saastv-local-api.service"
    ssh $SshHost "systemctl restart saastv-local-api.service && systemctl is-active saastv-local-api.service"
  }
}

Write-Host ""
Write-Host "Deploy concluido."
Write-Host "Backup para rollback: $timestamp"
