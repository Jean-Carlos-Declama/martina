# Publica el enlace de Martina en Cloudflare y deja la app apuntando a la nube.
#
# Antes (una sola vez), en E:\Martina:
#   npx.cmd dexie-cloud create      (crea la base: dexie-cloud.json y dexie-cloud.key)
#   npx.cmd wrangler login          (entra a tu cuenta de Cloudflare)
# Luego:
#   powershell -ExecutionPolicy Bypass -File E:\Martina\enlace\publicar.ps1
#   (con -NuevaLlave cambia la llave del negocio: los QR viejos dejan de servir)

#   (-Subdominio si tu cuenta de Cloudflare usa otro: https://martina-enlace.<subdominio>.workers.dev)

param([switch]$NuevaLlave, [string]$Subdominio = 'martina-rd')
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path $here -Parent
$appUrl = 'https://jean-carlos-declama.github.io/martina/'
$utf8 = New-Object System.Text.UTF8Encoding $false

# 1. La base en Dexie Cloud y su clave (nunca van a GitHub).
$dbUrl = (Get-Content (Join-Path $root 'dexie-cloud.json') -Raw | ConvertFrom-Json).dbUrl
$keyJson = Get-Content (Join-Path $root 'dexie-cloud.key') -Raw | ConvertFrom-Json
$cred = $null
if ($keyJson.clientId) { $cred = $keyJson }
foreach ($p in $keyJson.PSObject.Properties) { if ($p.Value.clientId) { $cred = $p.Value } }
if (-not $dbUrl -or -not $cred) { throw 'No encontre la base o la clave de Dexie Cloud (dexie-cloud.json / dexie-cloud.key).' }
Write-Host "Base de Dexie Cloud: $dbUrl"

# 2. Que Dexie Cloud acepte la app publicada y la de pruebas en esta PC.
Push-Location $root
try {
  npx.cmd -y dexie-cloud whitelist https://jean-carlos-declama.github.io
  npx.cmd -y dexie-cloud whitelist http://localhost:4173
} finally { Pop-Location }

# 3. La llave del negocio (la del QR).
$keyFile = Join-Path $here '.activacion.txt'
if ($NuevaLlave -or -not (Test-Path $keyFile)) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  [IO.File]::WriteAllText($keyFile, $secret, $utf8)
  Write-Host 'Llave del negocio nueva creada.'
}
$secret = ([IO.File]::ReadAllText($keyFile)).Trim()

# 4. Publicar el enlace y guardarle los secretos. Wrangler puede hacer preguntas: se ven aqui, contesta "y".
$tomlFile = Join-Path $here 'wrangler.toml'
$toml = [IO.File]::ReadAllText($tomlFile)
if ($toml -match 'DB_URL = ') { $toml = [regex]::Replace($toml, 'DB_URL = "[^"]*"', "DB_URL = `"$dbUrl`"") }
else { $toml = $toml.Replace('[vars]', "[vars]`nDB_URL = `"$dbUrl`"") }
[IO.File]::WriteAllText($tomlFile, $toml, $utf8)
$linkUrl = "https://martina-enlace.$Subdominio.workers.dev/token"
Push-Location $here
try {
  npx.cmd -y wrangler@4 deploy
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo publicar el enlace (arriba esta el detalle).' }

  $secretsFile = Join-Path $env:TEMP ('martina-secretos-' + [guid]::NewGuid() + '.json')
  $secrets = @{ CLIENT_ID = $cred.clientId; CLIENT_SECRET = $cred.clientSecret; LINK_SECRET = $secret } | ConvertTo-Json
  [IO.File]::WriteAllText($secretsFile, $secrets, $utf8)
  try { npx.cmd -y wrangler@4 secret bulk $secretsFile } finally { Remove-Item $secretsFile -Force }
} finally { Pop-Location }

# 5. La app apunta a la nube (src/config.ts: estas direcciones no son secretas).
$configFile = Join-Path $root 'src\config.ts'
$config = [IO.File]::ReadAllText($configFile)
$config = [regex]::Replace($config, "databaseUrl: '[^']*'", "databaseUrl: '$dbUrl'")
$config = [regex]::Replace($config, "linkUrl: '[^']*'", "linkUrl: '$linkUrl'")
[IO.File]::WriteAllText($configFile, $config, $utf8)
Write-Host "Listo: src\config.ts apunta a $dbUrl y a $linkUrl"

# 6. El QR de activacion para el iPad principal (solo en esta PC; no lo mandes por foto).
$qrFile = Join-Path $here '.activacion-qr.png'
Push-Location $root
try { node -e "require('qrcode').toFile(process.argv[1], process.argv[2], { width: 420, margin: 2 })" $qrFile ($appUrl + '#vincular=' + $secret) } finally { Pop-Location }
Write-Host "QR de activacion: $qrFile"
Write-Host 'Dile a Claude "listo".'
