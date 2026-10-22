param([string]$Version = '24.21.0', [string]$Destination = "$env:RUNNER_TEMP\xiaoyunque-node-runtime")
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Node.js version' }
$absoluteDestination = [System.IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $absoluteDestination -Force | Out-Null
$archiveName = "node-v$Version-win-x64.zip"
$archivePath = Join-Path $absoluteDestination $archiveName
$checksumPath = Join-Path $absoluteDestination 'SHASUMS256.txt'
$baseUrl = "https://nodejs.org/dist/v$Version"
Invoke-WebRequest -Uri "$baseUrl/$archiveName" -OutFile $archivePath
Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -OutFile $checksumPath
$line = Get-Content -LiteralPath $checksumPath | Where-Object { $_ -match "^[a-f0-9]{64}\s+$([regex]::Escape($archiveName))$" } | Select-Object -First 1
if (-not $line) { throw 'Official archive checksum is missing' }
$expectedHash = ($line -split '\s+')[0]
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Node.js checksum mismatch' }
Expand-Archive -LiteralPath $archivePath -DestinationPath $absoluteDestination
$runtimeDirectory = Join-Path $absoluteDestination "node-v$Version-win-x64"
$signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $runtimeDirectory 'node.exe')
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*OpenJS Foundation*') { throw 'Node.js signature verification failed' }
if ($env:GITHUB_OUTPUT) { "runtime_directory=$runtimeDirectory" | Out-File -FilePath $env:GITHUB_OUTPUT -Encoding utf8 -Append }
Write-Output 'Official Node.js archive checksum and OpenJS Foundation signature verified.'
