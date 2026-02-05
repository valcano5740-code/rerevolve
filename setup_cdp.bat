@echo off
:: Antigravity CDP Setup - 한 번 실행으로 전체 설정
:: 모든 PC에서 작동 (환경변수 사용)
:: VBS 사용으로 창 없이 실행

echo ================================================================
echo  Antigravity CDP 설정 스크립트
echo ================================================================
echo.

set "GEMINI_DIR=%USERPROFILE%\.gemini\antigravity"
set "VBS_FILE=%GEMINI_DIR%\antigravity_cdp.vbs"

if not exist "%GEMINI_DIR%" mkdir "%GEMINI_DIR%"

:: 1. VBS 스크립트 생성
echo Set WshShell = CreateObject("WScript.Shell") > "%VBS_FILE%"
echo Set fso = CreateObject("Scripting.FileSystemObject") >> "%VBS_FILE%"
echo If WScript.Arguments.Count ^> 0 Then >> "%VBS_FILE%"
echo     targetDir = WScript.Arguments(0) >> "%VBS_FILE%"
echo Else >> "%VBS_FILE%"
echo     targetDir = WshShell.CurrentDirectory >> "%VBS_FILE%"
echo End If >> "%VBS_FILE%"
echo antigravityPath = WshShell.ExpandEnvironmentStrings("%%LOCALAPPDATA%%") ^& "\Programs\Antigravity\Antigravity.exe" >> "%VBS_FILE%"
echo WshShell.CurrentDirectory = targetDir >> "%VBS_FILE%"
echo WshShell.Run """" ^& antigravityPath ^& """ --remote-debugging-port=9000", 0, False >> "%VBS_FILE%"

echo [1/2] antigravity_cdp.vbs 생성 완료 (창 없이 실행)

:: 2. 레지스트리 등록 (PowerShell 사용)
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "New-Item -Path 'HKCU:\Software\Classes\Directory\Background\shell\AntigravityCDP' -Force | Out-Null; ^
   Set-ItemProperty -Path 'HKCU:\Software\Classes\Directory\Background\shell\AntigravityCDP' -Name '(Default)' -Value 'Antigravity (CDP)'; ^
   Set-ItemProperty -Path 'HKCU:\Software\Classes\Directory\Background\shell\AntigravityCDP' -Name 'Icon' -Value \"$env:LOCALAPPDATA\Programs\Antigravity\Antigravity.exe\"; ^
   New-Item -Path 'HKCU:\Software\Classes\Directory\Background\shell\AntigravityCDP\command' -Force | Out-Null; ^
   Set-ItemProperty -Path 'HKCU:\Software\Classes\Directory\Background\shell\AntigravityCDP\command' -Name '(Default)' -Value ('wscript.exe \"' + $env:USERPROFILE + '\.gemini\antigravity\antigravity_cdp.vbs\" \"%%V\"'); ^
   New-Item -Path 'HKCU:\Software\Classes\Directory\shell\AntigravityCDP' -Force | Out-Null; ^
   Set-ItemProperty -Path 'HKCU:\Software\Classes\Directory\shell\AntigravityCDP' -Name '(Default)' -Value 'Antigravity (CDP)'; ^
   Set-ItemProperty -Path 'HKCU:\Software\Classes\Directory\shell\AntigravityCDP' -Name 'Icon' -Value \"$env:LOCALAPPDATA\Programs\Antigravity\Antigravity.exe\"; ^
   New-Item -Path 'HKCU:\Software\Classes\Directory\shell\AntigravityCDP\command' -Force | Out-Null; ^
   Set-ItemProperty -Path 'HKCU:\Software\Classes\Directory\shell\AntigravityCDP\command' -Name '(Default)' -Value ('wscript.exe \"' + $env:USERPROFILE + '\.gemini\antigravity\antigravity_cdp.vbs\" \"%%1\"')"

echo [2/2] 우클릭 메뉴 등록 완료

echo.
echo ================================================================
echo  설정 완료!
echo  폴더 우클릭 -^> "Antigravity (CDP)" 로 실행하세요.
echo  (cmd 창 없이 실행됩니다)
echo ================================================================
echo.
pause
