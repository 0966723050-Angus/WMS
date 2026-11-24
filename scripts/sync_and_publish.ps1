# Continue (not Stop): in PowerShell 5.1 "2>&1" on git/python turns normal stderr output
# (e.g. git push progress) into terminating errors under Stop. Exit codes are checked explicitly.
$ErrorActionPreference = "Continue"
$repo = "C:\ATK\Project\AI Agent\WMS-Web"
$logFile = Join-Path $repo "scripts\sync_and_publish.log"
$errFile = Join-Path $repo "scripts\sync_and_publish_err.log"

# 2026-11-24: the log write itself failed once (file briefly locked) and killed the whole publish
# with no trace. Log now retries, falls back to a second file, and never throws.
function Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    for ($i = 0; $i -lt 5; $i++) {
        try { Add-Content -Path $logFile -Value $line -Encoding utf8 -ErrorAction Stop; return }
        catch { $lastErr = $_.Exception.Message; Start-Sleep -Milliseconds 500 }
    }
    try { Add-Content -Path $errFile -Value "$line   (main log write failed: $lastErr)" -Encoding utf8 -ErrorAction Stop } catch { }
}

try {
    Set-Location $repo -ErrorAction Stop
    $out = & python scripts\build_data.py 2>&1
    $code = $LASTEXITCODE
    foreach ($l in $out) { Log "$l" }
    if ($code -ne 0) { throw "build_data.py failed (exit $code)" }

    # data.enc (encrypted, used once auth_config.json exists) or data.json (plain, legacy mode)
    $paths = @("data.json", "data.enc", "cost.enc") | Where-Object { (Test-Path $_) -or (git ls-files $_) }
    $changed = git status --porcelain -- $paths
    if ($changed) {
        git add -A -- $paths
        if ($LASTEXITCODE -ne 0) { throw "git add failed (exit $LASTEXITCODE)" }
        $msg = git commit -m "Auto-sync data from WMS.xlsx ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))" 2>&1
        if ($LASTEXITCODE -ne 0) { throw "git commit failed (exit $LASTEXITCODE): $($msg -join ' / ')" }
        $msg = git push origin main 2>&1
        if ($LASTEXITCODE -ne 0) { throw "git push failed (exit $LASTEXITCODE): $($msg -join ' / ')" }
        Log "data changed - committed and pushed."
    } else {
        Log "No change in data - skipped."
    }
} catch {
    $detail = "ERROR: $($_.Exception.Message) | at line $($_.InvocationInfo.ScriptLineNumber)"
    Log $detail
    try { Add-Content -Path $errFile -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $detail" -Encoding utf8 } catch { }
    exit 1
}
