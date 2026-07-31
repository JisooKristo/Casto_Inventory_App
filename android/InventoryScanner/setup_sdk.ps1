$javaHome = 'C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot'
$env:JAVA_HOME = $javaHome
$env:Path = "$javaHome\bin;" + $env:Path
$sdkRoot = 'C:\Users\Admin_LDMoratalla\AppData\Local\Android\Sdk'
$cmdToolsDir = "$sdkRoot\cmdline-tools\latest"
New-Item -ItemType Directory -Force -Path $cmdToolsDir | Out-Null
$zipPath = "$env:TEMP\cmdline-tools.zip"
Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' -OutFile $zipPath
Expand-Archive -Path $zipPath -DestinationPath $sdkRoot -Force
Write-Host 'SDK root:' $sdkRoot
Write-Host 'cmdline-tools:' $cmdToolsDir
