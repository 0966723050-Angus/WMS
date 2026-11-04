# 排程用:把網頁送出的儲位編輯寫進 WMS.xlsx,有寫入才接著重新產生 data.json 並發布。
# 沒有設定檔、沒有待處理修改、或 WMS 更新流程正在執行時,都會直接結束。
$ErrorActionPreference = "Stop"
$repo = "C:\ATK\Project\AI Agent\WMS-Web"
$logFile = Join-Path $repo "scripts\apply_edits.log"

function Log($msg) {
    Add-Content -Path $logFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg" -Encoding utf8
}

Set-Location $repo

if (-not (Test-Path (Join-Path $repo "scripts\edit_config.json"))) { exit 0 }

# WMS 更新流程(一鍵更新.exe / schedule_wms.ps1)執行中先不處理,避免兩邊同時寫入主檔
$busy = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -like 'WMS*.exe' -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*schedule_wms.ps1*')
}
if ($busy) {
    Log "WMS 更新流程執行中,略過本次"
    exit 0
}

try {
    python -I scripts\apply_edits.py | Out-Null
    if ($LASTEXITCODE -eq 10) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo "scripts\sync_and_publish.ps1")
    }
} catch {
    Log "ERROR: $($_.Exception.Message)"
}
