@echo off
REM Took PC 端的构建/测试包装：vcvars64 + RUSTUP_HOME/CARGO_HOME 三件套一次设好。
REM 用法（在 pc 目录下）：
REM   cmd /c _build_test.cmd test
REM   cmd /c _build_test.cmd build
REM 注意：改过 ui/ 之后必须重新 build —— 前端资源是编译期嵌进 exe 的。
call D:\work\vs-buildtools\VC\Auxiliary\Build\vcvars64.bat >nul 2>&1
set RUSTUP_HOME=D:\work\rust\rustup
set CARGO_HOME=D:\work\rust\cargo
cd /d D:\work\Project\Took\pc\src-tauri
D:\work\rust\cargo\bin\cargo.exe %*
