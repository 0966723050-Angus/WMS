$ErrorActionPreference = "Stop"
$repo = "C:\ATK\Project\AI Agent\WMS-Web"
$logFile = Join-Path $repo "scripts\sync_and_publish.log"

function Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

Set-Location $repo

try {
    python scripts\build_data.py | ForEach-Object { Log $_ }

    $changed = git status --porcelain data.json
    if ($changed) {
        git add data.json
        git commit -m "Auto-sync data.json from WMS.xlsx ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))" | Out-Null
        git push origin main | Out-Null
        Log "data.json changed - committed and pushed."
    } else {
        Log "No change in data.json - skipped."
    }
} catch {
    Log "ERROR: $($_.Exception.Message)"
}
