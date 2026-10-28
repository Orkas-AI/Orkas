!define ORKAS_INSTALLER_CLEANUP "${__FILEDIR__}\windows-installer-processes.ps1"

; One scoped check owns both installer and uninstaller cleanup. Do not fall
; through to the upstream directory-prefix/image-name process check.
!macro orkasCheckAppProcesses
  InitPluginsDir
  File /oname=$PLUGINSDIR\orkas-installer-cleanup.ps1 "${ORKAS_INSTALLER_CLEANUP}"
  Push $R0
  Push $0
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  ${if} ${isUpdated}
    ; The app has already saved its state; allow its normal exit to finish.
    Sleep 1000
  ${endif}

  orkas_cleanup_retry:
    ${if} ${RunningX64}
      ${DisableX64FSRedirection}
    ${endif}
    nsExec::Exec /TIMEOUT=20000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\orkas-installer-cleanup.ps1" -InstallDir "$INSTDIR" -InstallerProcessId $0'
    Pop $R0
    ${if} ${RunningX64}
      ${EnableX64FSRedirection}
    ${endif}
    ${if} $R0 != 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY orkas_cleanup_retry
      SetErrorLevel 2
      Quit
    ${endif}
  Pop $0
  Pop $R0
!macroend

!macro customInit
  !insertmacro orkasCheckAppProcesses
!macroend

!macro customCheckAppRunning
  !insertmacro orkasCheckAppProcesses
!macroend
