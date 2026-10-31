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
# With UpgradeFrom (a release tag; canary.yml `upgrade_from`) the owner installs that release first
# and the unreleased build over it (run.ts --upgrade-from): Windows then shows its approval prompt on
# the owner's desktop, and uac-approver.ps1, started there as SYSTEM, photographs and approves it.
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
  [string] $UpgradeFrom = "",
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
# How long an account's task may take to start. A first sign-in's desktop can still be getting ready
# after its explorer.exe runs, and a task started then ends at once without running its script.
$TaskStartMinutes = 10
# How long between starting a task and asking whether it started.
$TaskStartPollSeconds = 15
# How long an account's run may take, and the margin the wait leaves Task Scheduler to end it.
$TaskRunMinutes = 80
$TaskEndMarginMinutes = 5
# Task Scheduler's result for a task that never ran (SCHED_S_TASK_HAS_NOT_RUN), and this script's
# for a run whose script never started.
$TaskHasNotRun = 267011
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

# Whether `Task` started at or after `Since`: running now, or already run (a short run ends between polls).
function Test-TaskStarted([string] $Task, [datetime] $Since) {
  if ((Get-ScheduledTask -TaskName $Task).State -eq "Running") { return $true }
  return (Get-ScheduledTaskInfo -TaskName $Task).LastRunTime -ge $Since
}

# Wait while `Task` runs, at most its time limit and a margin.
function Wait-TaskEnd([string] $Task) {
  $deadline = (Get-Date).AddMinutes($TaskRunMinutes + $TaskEndMarginMinutes)
  while ((Get-ScheduledTask -TaskName $Task).State -eq "Running" -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }
}

# Start `Task` and wait for it to end; whether its script ran (it left `Log`, which its command
# line opens first). A task that never started, or ended without its script running, ran nothing:
# it is started again until $TaskStartMinutes have passed.
function Start-TaskRun([string] $Task, [string] $Log) {
  $deadline = (Get-Date).AddMinutes($TaskStartMinutes)
  while ((Get-Date) -lt $deadline) {
    $since = (Get-Date).AddSeconds(-2)
    try { Start-ScheduledTask -TaskName $Task | Out-Null } catch { Write-Host "starting ${Task}: $_" }
    Start-Sleep -Seconds $TaskStartPollSeconds
    $started = (Test-Path $Log) -or (Test-TaskStarted $Task $since)
    if (-not $started) {
      Write-Host "$Task has not started yet ($((Get-ScheduledTask -TaskName $Task).State)); starting it again"
      continue
    }
    Wait-TaskEnd $Task
    if (Test-Path $Log) { return $true }
    Write-Host "$Task ended with result $((Get-ScheduledTaskInfo -TaskName $Task).LastTaskResult) before its script ran; starting it again"
  }
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue | Out-Null
  return $false
}

# Run a script as `Name` in its logged-on desktop with its ordinary (unelevated) token; its exit
# code, or $TaskHasNotRun when the script never started.
function Invoke-Interactive([string] $Name, [string] $Script, [string] $Log) {
  $file = Join-Path $Root "$((Get-Random)).ps1"
  Set-Content -Path $file -Value $Script -Encoding UTF8
  $task = "genex-canary-$((Get-Random))"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $Root `
    -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"& '$file' *> '$Log'; exit `$LASTEXITCODE`""
  $principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$Name" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $TaskRunMinutes) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  Remove-Item $Log -Force -ErrorAction SilentlyContinue
  $code = $TaskHasNotRun
  if (Start-TaskRun $task $Log) { $code = (Get-ScheduledTaskInfo -TaskName $task).LastTaskResult }
  Unregister-ScheduledTask -TaskName $task -Confirm:$false
  # To the host, not the pipeline: the function's output is its exit code alone.
  Get-Content $Log -ErrorAction SilentlyContinue | Select-Object -Last 40 | Write-Host
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
    # The owner approves Genex's one administrator prompt; a test cannot click Yes, so it passes by
    # itself. An upgrade run counts the prompts of the update itself, so its owner is an ordinary
    # administrator made here (azure.ts names it): Azure's own account is the built-in
    # Administrator, which runs elevated and is never asked, even under Admin Approval Mode.
    # uac-approver.ps1 turns prompting on as the update starts and sees, photographs and approves
    # each prompt, on the normal desktop.
    $policies = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
    Set-ItemProperty $policies ConsentPromptBehaviorAdmin 0
    if ($UpgradeFrom) {
      Set-ItemProperty $policies EnableLUA 1 -Type DWord
      Set-ItemProperty $policies PromptOnSecureDesktop 0
      $ownerSecure = ConvertTo-SecureString $OwnerPassword -AsPlainText -Force
      New-LocalUser -Name $OwnerName -Password $ownerSecure -PasswordNeverExpires -AccountNeverExpires -Description "Genex canary owner" | Out-Null
      Add-LocalGroupMember -SID "S-1-5-32-544" -Member $OwnerName
    }
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
    $upgrade = ""
    $stop = Join-Path $Root "uac-stop"
    if ($UpgradeFrom) {
      $upgrade = " --upgrade-from '$UpgradeFrom'"
      Remove-Item $stop -Force -ErrorAction SilentlyContinue
      $approver = "$Upload\scripts\canary\windows\uac-approver.ps1"
      # Started through WMI, outside Run Command's job: a job cannot hold processes of two sessions,
      # so starting one in the owner's session from inside it is refused ("Access is denied").
      # Without the helper the update elevates without asking and the run fails its approval step.
      $launcher = Join-Path $Root "start-approver.ps1"
      $launchLog = Join-Path $out "approver-start.log"
      $line = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$approver`" -Out `"$out`" -Stop `"$stop`""
      Set-Content -Path $launcher -Encoding UTF8 -Value @(
        "`$env:CANARY_DISPOSABLE = '1'",
        "try { & '$Upload\scripts\canary\windows\in-session.ps1' -UserName '$OwnerName' -CommandLine '$($line -replace "'", "''")' *> '$launchLog' }",
        "catch { `"the approval helper did not start: `$_`" | Out-File -Append '$launchLog' }"
      )
      $made = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
        -Arguments @{ CommandLine = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$launcher`"" }
      Start-Sleep -Seconds 20
      Write-Output "approval helper launcher: WMI result $($made.ReturnValue); $((Get-Content $launchLog -ErrorAction SilentlyContinue) -join ' ')"
    }
    $script = @(
      "& '$Node' '$Upload\scripts\canary\lived-in-profile.ts' --home `$env:USERPROFILE --force-own-home --files $Files",
      "& '$Node' '$Upload\scripts\canary\run.ts' --machine '$Machine' --kind exe --tag '$Tag' --persona owner --evidence '$out' --release-src '$Upload\release-src'$(if (Test-Path $Built) { " --package '$Built'" })$upgrade",
      "exit `$LASTEXITCODE"
    ) -join "`n"
    $code = Invoke-Interactive $OwnerName $script (Join-Path $Evidence "owner.out.log")
    if ($UpgradeFrom) { New-Item -ItemType File -Force -Path $stop | Out-Null }
    Set-AutoLogon $UserName $UserPassword
    if ($code -eq $TaskHasNotRun) { Write-Output "owner run did not start in $TaskStartMinutes minutes" }
    Write-Output "owner run exit $code; $UserName logs on next"
  }
  "Standard" {
    # The owner's first start sets the sandbox up: without it this run could only fail on that, and
    # azure.ts reports the owner's missing run instead.
    if (-not (Test-Path "$Evidence\owner\result.json")) {
      Write-Output "standard user run skipped: the owner's run left no result"
      break
    }
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
