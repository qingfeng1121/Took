@echo off
set GOROOT=D:\work\GO\go
set GOPATH=D:\work\GO\gopath
set GOCACHE=D:\work\GO\gocache
set GOFLAGS=-mod=mod
set PATH=%GOROOT%\bin;%PATH%
cd /d D:\work\Project\Took\server
D:\work\GO\go\bin\go.exe run ./_q "C:\Users\30803\AppData\Roaming\app.took.desktop\took.db" 2>&1