@echo off
chcp 65001 >nul
cd /d "%~dp0..\.."

rem fallback: point to local Node install if npm/node is not on PATH
node --version >nul 2>&1 || set "PATH=E:\New Folder\nodejs;%PATH%"

echo.
echo Web dev server -^> http://localhost:5173/
echo Make sure the backend is running first (api test folder, 13-M8 bat).
echo Today page: http://localhost:5173/today
echo.
echo Keep this window open while using the site. Press Ctrl+C to stop.
echo.

npm run dev:web