@echo off
rem Collects NABARD circulars from this PC in India (NABARD does not answer GitHub's servers abroad)
rem and pushes them to rrmohite-updates. Uses its own copy of the repo, so no work in progress is touched.
rem Installed by local\install-nabard-task.cmd; runs every 6 hours while the PC is on.
setlocal
set "DIR=%LOCALAPPDATA%\rrmohite-nabard"
set "LOG=%DIR%\last-run.log"
if not exist "%DIR%" mkdir "%DIR%"
echo %DATE% %TIME% > "%LOG%"
if not exist "%DIR%\repo\.git" git clone -q https://github.com/asktheca296/rrmohite-updates.git "%DIR%\repo" >> "%LOG%" 2>&1
cd /d "%DIR%\repo" || exit /b 1
for /l %%n in (1,1,3) do (
  git fetch -q origin >> "%LOG%" 2>&1
  git reset -q --hard origin/main >> "%LOG%" 2>&1
  node fetch.mjs --only NABARD >> "%LOG%" 2>&1
  git diff --quiet updates.json && goto :done
  git -c user.name=asktheca296 -c user.email=asktheca296@users.noreply.github.com commit -q -m "NABARD circulars (collected from India)" updates.json >> "%LOG%" 2>&1
  git push -q origin HEAD:main >> "%LOG%" 2>&1 && goto :done
)
:done
echo finished >> "%LOG%"
