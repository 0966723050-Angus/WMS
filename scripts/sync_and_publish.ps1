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

    # data.enc (encrypted, used once auth_config.json exists) or data.json (plain, legacy mode)
    $paths = @("data.json", "data.enc") | Where-Object { (Test-Path $_) -or (git ls-files $_) }
    $changed = git status --porcelain -- $paths
    if ($changed) {
        git add -A -- $paths
        git commit -m "Auto-sync data from WMS.xlsx ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))" | Out-Null
        git push origin main | Out-Null
        Log "data changed - committed and pushed."
    } else {
        Log "No change in data - skipped."
    }
} catch {
    Log "ERROR: $($_.Exception.Message)"
}
