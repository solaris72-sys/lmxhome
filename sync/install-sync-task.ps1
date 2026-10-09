# Creates (or replaces) the "LMX Home Sync" scheduled task, which syncs the Obsidian road maps with
# lmxhome.netlify.app every 5 minutes while you're logged in. Remove it with: Unregister-ScheduledTask "LMX Home Sync"
$vbs = Join-Path $PSScriptRoot "run-sync-hidden.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
Register-ScheduledTask -TaskName "LMX Home Sync" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Scheduled task 'LMX Home Sync' installed (every 5 minutes)."
