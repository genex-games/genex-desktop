# One phase of the Windows canary on an Azure VM, run as SYSTEM through Run Command
# (scripts/canary/azure.ts calls each phase in turn, restarting the VM between them so the next
# account is logged on at its desktop):
#
#   Prepare   fetch Node and the canary scripts, create the standard user, log the owner on next boot
#   Owner     the owner's run on a lived-in profile: download, install, first start (sets the sandbox
#             up), agent command, as on a home PC; an unreleased build the job put in the scripts'
#             canary-package folder is installed instead of the download
#   Standard  the standard user's lived-in profile and run, at its own desktop (standard-user.ps1)
#   Collect   zip the evidence and upload it to the run's storage
#
# The VM exists for one run and is deleted after it; nothing here runs on a person's machine.
param(
  [Parameter(Mandatory)] [string] $Phase,
  [string] $Machine = "",
  [string] $Tag = "",
  [string] $SourceUrl = "",
  [string] $NodeVersion = "",
  [string] $OwnerName = "",
  [string] $OwnerPassword = "",
  [string] $UserName = "canary-user",
  [string] $UserPassword = "",
  [string] $UploadUrl = "",
  [int] $Files = 150000
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Every value comes base64-encoded (azure.ts): Run Command passes them on a command line of its own.
function Decode([string] $Value) {
  if (-not $Value) { return $Value }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}
foreach ($name in @($PSBoundParameters.Keys)) {
  if ($name -ne "Files") { Set-Variable -Name $name -Value (Decode $PSBoundParameters[$name]) }
}
if ($Phase -notin @("Prepare", "Owner", "Standard", "Collect")) { throw "unknown phase $Phase" }
$Root = "C:\canary"
$Upload = Join-Path $Root "upload"
$Node = Join-Path $Root "node\node.exe"
$Evidence = Join-Path $Root "evidence"
$Winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
[Environment]::SetEnvironmentVariable("CANARY_DISPOSABLE", "1", "Machine")
$env:CANARY_DISPOSABLE = "1"

# Log `Name` on at the next boot, at the console, as a person sitting at the PC.
function Set-AutoLogon([string] $Name, [string] $Password) {
  Set-ItemProperty $Winlogon AutoAdminLogon "1"
  Set-ItemProperty $Winlogon DefaultUserName $Name
  Set-ItemProperty $Winlogon DefaultPassword $Password
  Set-ItemProperty $Winlogon DefaultDomainName $env:COMPUTERNAME
}

# Wait until `Name` has a desktop (its explorer.exe runs), where an interactive task can start.
function Wait-Desktop([string] $Name) {
  $deadline = (Get-Date).AddMinutes(10)
  while ((Get-Date) -lt $deadline) {
    $shell = Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -like "*\$Name" }
    if ($shell) { Start-Sleep -Seconds 20; return }
    Start-Sleep -Seconds 5
  }
  throw "$Name never reached a desktop"
}

# Run a script as `Name` in its logged-on desktop with its ordinary (unelevated) token; its exit code.
function Invoke-Interactive([string] $Name, [string] $Script, [string] $Log) {
  $file = Join-Path $Root "$((Get-Random)).ps1"
  Set-Content -Path $file -Value $Script -Encoding UTF8
  $task = "genex-canary-$((Get-Random))"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $Root `
    -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"& '$file' *> '$Log'; exit `$LASTEXITCODE`""
  $principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$Name" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 80) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $task
  do { Start-Sleep -Seconds 5 } while ((Get-ScheduledTask -TaskName $task).State -eq "Running")
  $code = (Get-ScheduledTaskInfo -TaskName $task).LastTaskResult
  Unregister-ScheduledTask -TaskName $task -Confirm:$false
  Get-Content $Log -ErrorAction SilentlyContinue | Select-Object -Last 40 | Write-Output
  return $code
}

# An unreleased build's installer, when the job checks one (canary.yml `package_run`).
$Built = Join-Path $Upload "canary-package\Genex-Setup.exe"
switch ($Phase) {
  "Prepare" {
    New-Item -ItemType Directory -Force -Path $Upload, $Evidence, (Split-Path $Node) | Out-Null
    # Node, checked against the release's published sums.
    $base = "https://nodejs.org/dist/v$NodeVersion"
    $zip = "node-v$NodeVersion-win-x64.zip"
    Invoke-WebRequest "$base/$zip" -OutFile "$Root\$zip" -UseBasicParsing
    $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
    $expected = ($sums | Where-Object { $_ -match "  $([regex]::Escape($zip))$" }) -replace "\s.*$", ""
    $actual = (Get-FileHash "$Root\$zip" -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $expected -ne $actual) { throw "node $zip sha256 $actual is not the published $expected" }
    Expand-Archive "$Root\$zip" -DestinationPath "$Root\node-x" -Force
    Copy-Item "$Root\node-x\node-v$NodeVersion-win-x64\*" (Split-Path $Node) -Recurse -Force
    # The canary scripts and the release's e2e runner, as the job zipped them.
    Invoke-WebRequest $SourceUrl -OutFile "$Root\src.zip" -UseBasicParsing
    Expand-Archive "$Root\src.zip" -DestinationPath $Upload -Force
    icacls $Root /grant "*S-1-5-11:(OI)(CI)M" /T /C /Q | Out-Null
    # The owner approves Genex's one administrator prompt; a test cannot click Yes, so it passes by itself.
    Set-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" ConsentPromptBehaviorAdmin 0
    # A new account's first sign-in goes straight to the desktop (no privacy questions or animation).
    New-Item -Force "HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE" | Out-Null
    Set-ItemProperty "HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE" DisablePrivacyExperience 1 -Type DWord
    Set-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" EnableFirstLogonAnimation 0 -Type DWord
    New-Item -Force "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device" | Out-Null
    Set-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device" DevicePasswordLessBuildVersion 0 -Type DWord
    $secure = ConvertTo-SecureString $UserPassword -AsPlainText -Force
    New-LocalUser -Name $UserName -Password $secure -PasswordNeverExpires -AccountNeverExpires -Description "Genex canary" | Out-Null
    Add-LocalGroupMember -SID "S-1-5-32-545" -Member $UserName
    Set-AutoLogon $OwnerName $OwnerPassword
    Write-Output "prepared: node $NodeVersion, scripts in $Upload, $OwnerName logs on next"
  }
  "Owner" {
    Wait-Desktop $OwnerName
    $out = Join-Path $Evidence "owner"
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    $script = @(
      "& '$Node' '$Upload\scripts\canary\lived-in-profile.ts' --home `$env:USERPROFILE --force-own-home --files $Files",
      "& '$Node' '$Upload\scripts\canary\run.ts' --machine '$Machine' --kind exe --tag '$Tag' --persona owner --evidence '$out' --release-src '$Upload\release-src'$(if (Test-Path $Built) { " --package '$Built'" })",
      "exit `$LASTEXITCODE"
    ) -join "`n"
    $code = Invoke-Interactive $OwnerName $script (Join-Path $Evidence "owner.out.log")
    Set-AutoLogon $UserName $UserPassword
    Write-Output "owner run exit $code; $UserName logs on next"
  }
  "Standard" {
    Wait-Desktop $UserName
    $env:Path = "$(Split-Path $Node);$env:Path"
    & "$Upload\scripts\canary\windows\standard-user.ps1" -Machine $Machine -Tag $Tag `
      -Package $(if (Test-Path $Built) { $Built } else { "$Evidence\owner\download\Genex-Setup.exe" }) -Source $Upload -ReleaseSrc "$Upload\release-src" `
      -Evidence "$Evidence\standard-user" -UserName $UserName -Password $UserPassword -Files $Files
    Write-Output "standard user run exit $LASTEXITCODE"
  }
  "Collect" {
    $zip = Join-Path $Root "evidence.zip"
    # The installer is no evidence, and it is most of the bytes.
    Get-ChildItem $Evidence -Recurse -Directory -Filter download | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path "$Evidence\*" -DestinationPath $zip -Force
    Invoke-WebRequest -Method Put -Uri $UploadUrl -InFile $zip -Headers @{ "x-ms-blob-type" = "BlockBlob" } -UseBasicParsing | Out-Null
    Write-Output "uploaded $((Get-Item $zip).Length) bytes of evidence"
  }
}
