param([string[]]$ImagePaths, [string]$ListFile, [string]$Lang = 'zh-Hant-TW')
# Windows 內建 OCR(Windows.Media.Ocr):一次辨識多張圖片,輸出 JSON 陣列(每張圖的每行文字與每個字詞的位置)。
# 不需要安裝任何套件;語言包用電腦已有的 zh-Hant-TW(繁體中文,也能辨識英數字)。
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File ocr_win.ps1 -ListFile list.txt   (list.txt 每行一個圖片路徑,UTF-8)
#       powershell -NoProfile -ExecutionPolicy Bypass -File ocr_win.ps1 -ImagePaths a.png          (單張)
$ErrorActionPreference = 'Stop'
if ($ListFile) { $ImagePaths = @(Get-Content -LiteralPath $ListFile -Encoding UTF8 | Where-Object { $_.Trim() }) }
if (-not $ImagePaths -or $ImagePaths.Count -eq 0) { throw '沒有指定圖片' }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}
$langObj = New-Object Windows.Globalization.Language($Lang)
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langObj)
if (-not $engine) { throw "找不到 OCR 語言 $Lang" }

$out = @()
foreach ($path in $ImagePaths) {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $path).Path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $result.Lines) {
        $words = @()
        foreach ($w in $line.Words) {
            $r = $w.BoundingRect
            $words += [pscustomobject]@{ t = $w.Text; x = [math]::Round($r.X, 1); y = [math]::Round($r.Y, 1); w = [math]::Round($r.Width, 1); h = [math]::Round($r.Height, 1) }
        }
        $lines += [pscustomobject]@{ text = $line.Text; words = $words }
    }
    $out += [pscustomobject]@{ path = $path; width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; text = $result.Text; lines = $lines }
    $stream.Dispose()
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
ConvertTo-Json -InputObject @($out) -Depth 6 -Compress
