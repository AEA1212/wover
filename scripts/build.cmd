@echo off
rem Runs build.ps1 without changing PowerShell's script policy. Usage: scripts\build.cmd [-Sign]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
