@echo off
setlocal
set DIR=%~dp0
if "%JAVA_HOME%"=="" (
  set JAVA_EXE=java
) else (
  set JAVA_EXE=%JAVA_HOME%\bin\java.exe
)
if not exist "%JAVA_EXE%" (
  echo JAVA_HOME is set to an invalid directory: %JAVA_HOME%
  exit /b 1
)
set CLASSPATH=%DIR%gradle\wrapper\gradle-wrapper.jar
if not exist "%CLASSPATH%" (
  echo Gradle wrapper jar not found. Please run the Gradle wrapper setup.
  exit /b 1
)
"%JAVA_EXE%" -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*
