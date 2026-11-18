$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  npm.cmd test
  if ($LASTEXITCODE -ne 0) { throw 'Medical lead-function tests failed' }
  $outputDir = Join-Path (Resolve-Path -LiteralPath '../../..').Path 'output'
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
  $zipPath = Join-Path $outputDir 'promedphoto-ydb-lead-function.zip'
  $files = @('index.js', 'validation.js', 'storage.js', 'postbox.js', 'postbox-store.js', 'package.json', 'package-lock.json')
  Compress-Archive -LiteralPath $files -DestinationPath $zipPath -Force
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    if (Compare-Object $files @($zip.Entries | ForEach-Object { $_.FullName })) { throw 'Unexpected archive contents' }
  } finally { $zip.Dispose() }
  Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
  Write-Output $zipPath
} finally { Pop-Location }
