# 打包 Edge 扩展为可分发 zip
# 用法：powershell -ExecutionPolicy Bypass -File extension/scripts/pack.ps1
#         或 pwsh -File extension/scripts/pack.ps1
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot        # extension/
$repo = Split-Path -Parent $root                # 仓库根
$outDir = Join-Path $repo "release"

# 用 .NET 显式按 UTF-8 读取，避免 Windows PowerShell 5.1 按 ANSI 读取中文 manifest 失败
$manifestText = [System.IO.File]::ReadAllText((Join-Path $root "manifest.json"), [System.Text.Encoding]::UTF8)
$manifest = $manifestText | ConvertFrom-Json
$version = $manifest.version
if (-not $version) { $version = "0.0.0" }

$tmp = Join-Path $repo (".tmp/package-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$zip = Join-Path $outDir ("ai-translate-" + $version + ".zip")

New-Item -ItemType Directory -Force -Path $tmp | Out-Null
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# 复制除 tests / scripts 之外的全部内容
Get-ChildItem -Path $root -Force | Where-Object {
    $_.Name -ne "tests" -and $_.Name -ne "scripts"
} | ForEach-Object {
    Copy-Item $_.FullName -Destination $tmp -Recurse -Force
}
$preview = Join-Path $tmp "src/assets/icon-preview.png"
if (Test-Path $preview) { Remove-Item $preview -Force }

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $tmp "*") -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

$sizeKb = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host ("打包完成: " + $zip + " (" + $sizeKb + " KB)")
Write-Host "解压后进入 Edge -> edge://extensions -> 加载解压缩的扩展 -> 选择解压出的目录"
