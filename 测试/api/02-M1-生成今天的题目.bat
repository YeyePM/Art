@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."

rem fallback: point to local Node install if npm/node is not on PATH
node --version >nul 2>&1 || set "PATH=E:\New Folder\nodejs;%PATH%"

node "app\api\scripts\verify-t3.js"

echo.
echo ---- Press any key to close ----
pause >nul