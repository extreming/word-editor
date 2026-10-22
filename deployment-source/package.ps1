$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectRoot = Split-Path -Parent $PSScriptRoot
$entries = [ordered]@{}
foreach ($name in @('Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'server.js')) {
    $source = Join-Path $projectRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing required file: $name" }
    $entries[$name] = $source
}
foreach ($directory in @('server', 'public')) {
    $sourceDirectory = Join-Path $projectRoot $directory
    if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) { throw "Missing directory: $directory" }
    foreach ($file in Get-ChildItem -LiteralPath $sourceDirectory -File -Recurse | Sort-Object FullName) {
        $relative = $file.FullName.Substring($projectRoot.Length + 1).Replace('\', '/')
        $entries[$relative] = $file.FullName
    }
}
foreach ($required in @('server/storage.js', 'server/dataLifecycle.js', 'server/scopedAuth.js', 'server/docConvert.js', 'server/docxNode.mjs', 'public/package.json', 'public/editor.html', 'public/js/main.js', 'public/js/editor.js', 'public/js/docx.js', 'public/js/sdk.js')) {
    if (-not $entries.Contains($required)) { throw "Missing required source: $required" }
}
$entries['DEPLOYMENT.md'] = Join-Path $PSScriptRoot 'README.md'

$outputDirectory = Join-Path $projectRoot 'deliverables'
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$archiveName = 'doc-editor-source-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip'
$archivePath = Join-Path $outputDirectory $archiveName
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::CreateNew)
try {
    $archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        foreach ($entry in $entries.GetEnumerator()) {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $entry.Value, ('doc-editor-source/' + $entry.Key), [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $archive.Dispose() }
} finally { $stream.Dispose() }
$digest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText(($archivePath + '.sha256'), "$digest  $archiveName`n", [System.Text.Encoding]::ASCII)
Write-Output "Created: $archivePath"
Write-Output "Files: $($entries.Count)"
Write-Output "SHA256: $digest"
