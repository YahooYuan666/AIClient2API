' AIClient2API silent launcher: no console window at all.
' 1) run proxy self-adapt (hidden); 2) start the server only if port 3000 is free.
Set sh = CreateObject("Wscript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)

' proxy self-adapt, hidden window, wait until done
sh.Run "cmd /c cd /d """ & base & """ && node proxy-adapt.mjs >> logs\adapt.log 2>&1", 0, True

' port check
Set exec = sh.Exec("cmd /c netstat -ano | findstr :3000 | findstr LISTENING")
Do While exec.Status = 0
    WScript.Sleep 100
Loop
portBusy = (Len(exec.StdOut.ReadAll()) > 0)

If Not portBusy Then
    ' start node directly, hidden (window style 0), do not wait
    sh.Run "cmd /c cd /d """ & base & """ && node src\core\master.js >> logs\service.log 2>&1", 0, False
End If
