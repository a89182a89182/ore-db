@echo off
chcp 65001 >nul
cd /d C:\Users\YOSHI\Documents\ore-db
where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] git not found. Please install Git for Windows.
  pause
  exit /b 1
)
if not exist .git (
  git init -b main
)
git config user.email "a89182a89182@gmail.com"
git config user.name "YOSHI"
git remote get-url origin >nul 2>&1
if errorlevel 1 git remote add origin https://github.com/a89182a89182/ore-db.git
git add -A
git commit -m "ORE weekly update %date% %time%"
git pull --rebase origin main --allow-unrelated-histories
git push -u origin main
echo.
echo ===== DONE =====
pause
