@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0bin\node.exe" (
  "%~dp0bin\node.exe" "%~dp0launch.mjs"
) else (
  node "%~dp0launch.mjs"
)
if errorlevel 1 pause
