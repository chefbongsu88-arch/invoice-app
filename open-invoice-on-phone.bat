@echo off
cd /d "%~dp0"
echo Starting Expo LAN - phone must be on same Wi-Fi as this PC.
echo If LAN fails: pnpm phone  OR for dev APK tunnel: pnpm phone:dev:tunnel
echo.
pnpm phone:lan
pause
