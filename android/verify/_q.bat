@echo off
set GOROOT=D:\work\GO\go
set GOPATH=D:\work\GO\gopath
set GOCACHE=D:\work\GO\gocache
set GOFLAGS=-mod=mod
set PATH=%GOROOT%\bin;%PATH%
cd /d D:\work\Project\Took\android\verify
go run _q.go D:\work\Project\Took\android\verify\_dev_took.db 2>&1