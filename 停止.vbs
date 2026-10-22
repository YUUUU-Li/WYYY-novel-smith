' ============================================================
'  WUYOU YIYAN - stop the hidden server
'
'  After 启动.vbs there is no window to close, so this is how you
'  stop the server. It only kills a process that is BOTH listening
'  on the port AND named node.exe, so it will not touch anything
'  else that happens to use the same port.
'
'  THIS FILE MUST STAY PURE ASCII.
' ============================================================
Option Explicit

Dim sh, port, cmd, rc

Set sh = CreateObject("WScript.Shell")
port = sh.Environment("PROCESS")("PORT")
If port = "" Then port = "5183"

cmd = "powershell -NoProfile -WindowStyle Hidden -Command """ & _
  "$c = Get-NetTCPConnection -LocalPort " & port & " -State Listen -ErrorAction SilentlyContinue;" & _
  "foreach ($x in $c) { $p = Get-Process -Id $x.OwningProcess -ErrorAction SilentlyContinue;" & _
  "if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force;" & _
  "Write-Output ('stopped pid ' + $p.Id) } }"""

rc = sh.Run(cmd, 0, True)
If rc = 0 Then
  MsgBox "Server stopped (port " & port & ")." & vbCrLf & vbCrLf & _
         "The app window will show a connection error from now on - just close it.", _
         vbInformation, "WUYOU YIYAN"
Else
  MsgBox "Nothing was listening on port " & port & ", or it was not node.exe." & vbCrLf & vbCrLf & _
         "If the app still works, the server is running on another port.", _
         vbInformation, "WUYOU YIYAN"
End If
