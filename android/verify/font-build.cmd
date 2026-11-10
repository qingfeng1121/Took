@echo off
set JAVA_HOME=D:\work\JDK\Jdk21
set ANDROID_HOME=D:\work\android-sdk
set GRADLE_USER_HOME=D:\work\gradle-home
set PATH=D:\work\JDK\Jdk21\bin;D:\work\android-sdk\platform-tools;D:\work\gradle\gradle-8.7\bin;%PATH%
cd /d D:\work\Project\Took\android
call gradle.bat %*
exit /b %ERRORLEVEL%
