' ============================================================
'  WUYOU YIYAN - windowless launcher
'
'  Double-click this file. It starts the local server with NO
'  console window, then opens the app in a browser app-window
'  (no tabs, no address bar - it looks like a normal program).
'
'  Why the old 启动.cmd had a black box: this is a web app, so a
'  local HTTP server has to run while you use it. A .cmd is the
'  most transparent way to show that. This file does the same
'  thing, just hidden.
'
'  Still keep 启动.cmd around: when something goes wrong, that
'  one shows the error messages.
'
'  THIS FILE MUST STAY PURE ASCII. wscript.exe reads .vbs with the
'  system ANSI code page unless it is UTF-16, so Chinese comments
'  would come out as mojibake (and can break the script).
' ============================================================
Option Explicit

Dim fso, sh, base, port, url, node, i

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)

port = sh.Environment("PROCESS")("PORT")
If port = "" Then port = "5183"
url = "http://127.0.0.1:" & port & "/"

node = FindNode(fso, sh, base)
If node = "" Then
  MsgBox "Node.js not found." & vbCrLf & vbCrLf & _
         "Install Node 20+ or run 启动.cmd once (it explains what is missing).", _
         vbExclamation, "WUYOU YIYAN"
  WScript.Quit 1
End If

' Already running? Then just bring up the window.
If Not PortOpen(port) Then
  sh.CurrentDirectory = base
  sh.Run """" & node & """ scripts\serve.mjs", 0, False
  For i = 1 To 150
    If PortOpen(port) Then Exit For
    WScript.Sleep 200
  Next
  If Not PortOpen(port) Then
    MsgBox "The server did not start in 30 seconds." & vbCrLf & vbCrLf & _
           "Run 启动.cmd - it shows the error message.", vbExclamation, "WUYOU YIYAN"
    WScript.Quit 1
  End If
End If

If sh.Environment("PROCESS")("NO_WINDOW") <> "1" Then OpenWindow fso, sh, url

' ------------------------------------------------------------

' node.exe: portable runtime first, then PATH, then the usual install spots
Function FindNode(f, s, b)
  Dim p, cand, exe
  FindNode = ""
  If f.FileExists(b & "\runtime\node.exe") Then
    FindNode = b & "\runtime\node.exe"
    Exit Function
  End If
  cand = Array( _
    s.Environment("PROCESS")("LOCALAPPDATA") & "\Programs\nodejs\node.exe", _
    s.Environment("PROCESS")("ProgramFiles") & "\nodejs\node.exe", _
    "C:\Program Files\nodejs\node.exe" _
  )
  For Each p In cand
    If p <> "" And f.FileExists(p) Then
      FindNode = p
      Exit Function
    End If
  Next
  ' Fall back to whatever PATH resolves; serve.mjs will fail loudly if it is junk
  On Error Resume Next
  exe = s.ExpandEnvironmentStrings("%PATH%")
  If InStr(LCase(exe), "nodejs") > 0 Then FindNode = "node"
  On Error GoTo 0
End Function

' Is something already listening on that port?
Function PortOpen(p)
  Dim http
  PortOpen = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP")
  http.Open "GET", "http://127.0.0.1:" & p & "/", False
  http.Send
  If Err.Number = 0 Then PortOpen = (http.Status >= 200 And http.Status < 500)
  On Error GoTo 0
End Function

' App-window first (no tabs / no address bar), plain browser as fallback
Sub OpenWindow(f, s, u)
  Dim edge, chrome
  edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  If Not f.FileExists(edge) Then edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  chrome = s.Environment("PROCESS")("ProgramFiles") & "\Google\Chrome\Application\chrome.exe"

  If f.FileExists(edge) Then
    s.Run """" & edge & """ --app=" & u, 1, False
  ElseIf f.FileExists(chrome) Then
    s.Run """" & chrome & """ --app=" & u, 1, False
  Else
    s.Run "cmd /c start """" """ & u & """", 0, False
  End If
End Sub
