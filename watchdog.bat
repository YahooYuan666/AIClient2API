@echo off
rem AIClient2API watchdog: proxy self-adapt + exit if port 3000 is already listening, otherwise start service (idempotent)
cd /d "%~dp0"
if not exist logs mkdir logs
node proxy-adapt.mjs >> logs\adapt.log 2>&1
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 exit /b 0
start "AIClient2API" /min cmd /c "npm start >> logs\service.log 2>&1"
exit /b 0