@echo off
chcp 65001 >nul
set SITE=C:\Users\YOSHI\Documents\ore-site
set DB=C:\Users\YOSHI\Documents\ore-db
if not exist "%SITE%\.git" (
  git clone https://github.com/a89182a89182/a89182a89182.github.io.git "%SITE%"
)
cd /d "%SITE%"
git config user.email "a89182a89182@gmail.com"
git config user.name "YOSHI"
git pull --rebase origin main
rem 取最新一份週報當首頁
set LATEST=
for %%f in ("%DB%\reports-weekly\ore_weekly_*.html") do set LATEST=%%f
if defined LATEST copy /Y "%LATEST%" "%SITE%\index.html" >nul
copy /Y "%DB%\PREDICTIONS.md" "%SITE%\PREDICTIONS.md" >nul
git add -A
git commit -m "ORE predictions update %date% %time%"
git push origin main
echo.
echo ===== SITE PUBLISHED: https://a89182a89182.github.io/ =====
pause
