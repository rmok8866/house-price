@echo off
title UK House Price History - Local Development Server
cd /d "%~dp0"
echo =======================================================
echo  Starting UK House Price History Development Server...
echo =======================================================
start http://localhost:5173
python serve.py
pause
