@echo off
chcp 65001 >nul
title AIClient2API
cd /d "%~dp0"
echo ========================================
echo   AIClient2API 启动中...
echo   控制台: http://127.0.0.1:3000
echo   关闭此窗口即停止服务
echo ========================================
npm start
pause