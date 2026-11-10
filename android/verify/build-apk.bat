@echo off
set JAVA_HOME=D:\work\JDK\Jdk21
set ANDROID_HOME=D:\work\android-sdk
set GRADLE_USER_HOME=D:\work\gradle-home
cd /d D:\work\Project\Took\android
call D:\work\gradle\gradle-8.7\bin\gradle.bat %*
