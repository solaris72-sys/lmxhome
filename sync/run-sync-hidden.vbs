' Runs sync-home.mjs with no console window (used by the "LMX Home Sync" scheduled task)
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "cmd /c cd /d """ & dir & """ && node sync-home.mjs", 0, False
