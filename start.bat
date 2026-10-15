@echo off
chcp 65001 >nul
cd /d "%~dp0"
netstat -ano | findstr /r /c:":8080 .*LISTENING" >nul
if %errorlevel%==0 (
  start "" http://localhost:8080
  exit /b
)
start "" http://localhost:8080
node server.js
pause
