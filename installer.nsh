; Custom NSIS hooks for the Mailmind installer (electron-builder `nsis.include`).
;
; Mailmind is a tray app: its window-close handler HIDES to the tray instead of
; quitting, so the default NSIS "app is running" check can never close it and shows
; "Mailmind cannot be closed. Please close it manually and click Retry." on every
; update. We fix that by force-killing the app (and the node.exe server it spawned,
; via /T for the whole tree) before the install proceeds. This runs inside the
; installer, so it works no matter which app version is currently running.

!macro customInit
  nsExec::Exec 'taskkill /F /T /IM "Mailmind.exe"'
  Pop $0
  Sleep 1500
!macroend

!macro customUnInit
  ; Same courtesy for the uninstaller — don't make the user hunt the tray.
  nsExec::Exec 'taskkill /F /T /IM "Mailmind.exe"'
  Pop $0
  Sleep 1000
!macroend
