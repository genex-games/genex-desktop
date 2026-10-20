# The Windows canary's second pass: an account without administrator rights, on a machine whose
# owner already installed Genex and set its sandbox up. It creates that account, fills its profile
# like a person's (lived-in-profile.ts), and runs the canary as it: install from the owner's
# checked Setup.exe, first start, agent command. Run it as an administrator on a disposable machine.
#
# The account's processes run in its own logged-on desktop through a scheduled task: the Azure VM
# logs it on at boot (azure-vm.ps1). Started from another account's session instead (runas,
# Start-Process -Credential), the sandbox cannot set up the session's objects for its runner, which
# no person signed in at their own desktop meets.
param(
  [Parameter(Mandatory)] [string] $Machine,
  [Parameter(Mandatory)] [string] $Tag,
  [Parameter(Mandatory)] [string] $Package,
  [Parameter(Mandatory)] [string] $Source,
  [Parameter(Mandatory)] [string] $Evidence,
  [string] $ReleaseSrc = "",
  [string] $UserName = "canary-user",
  [string] $Password = "",
  [int] $Files = 150000,
  [int] $TimeoutMinutes = 60
)
$ErrorActionPreference = "Stop"

if (-not $env:CANARY_DISPOSABLE) {
  throw "standard-user.ps1 creates a local account: it runs only on a disposable canary machine"
}

$Root = "C:\canary"
$Work = Join-Path $Root "work"
New-Item -ItemType Directory -Force -Path $Work, $Evidence | Out-Null

# The account sees a copy of Node, the canary scripts and the release's test runner, read-only.
$Node = Join-Path $Root "node\node.exe"
New-Item -ItemType Directory -Force -Path (Split-Path $Node) | Out-Null
$nodeSource = (Get-Command node).Source
if ($nodeSource -ne $Node) { Copy-Item $nodeSource $Node -Force }
robocopy $Source (Join-Path $Work "src") /E /NFL /NDL /NJH /NJS /XD .git node_modules | Out-Null
if ($ReleaseSrc) { robocopy $ReleaseSrc (Join-Path $Work "release-src") /E /NFL /NDL /NJH /NJS /XD .git node_modules | Out-Null }
icacls $Root /grant "*S-1-5-32-545:(OI)(CI)RX" /T /C /Q | Out-Null

if (-not $Password) {
  $Password = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 20 | ForEach-Object { [char]$_ }) + "!a1"
}
$Secure = ConvertTo-SecureString $Password -AsPlainText -Force
if (-not (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue)) {
  New-LocalUser -Name $UserName -Password $Secure -PasswordNeverExpires -AccountNeverExpires -Description "Genex canary" | Out-Null
}
Add-LocalGroupMember -SID "S-1-5-32-545" -Member $UserName -ErrorAction SilentlyContinue
icacls $Evidence /grant "${UserName}:(OI)(CI)M" /T /C /Q | Out-Null

# Run one PowerShell script as the account and wait; its exit code.
function Invoke-AsUser([string] $Script, [string] $Name) {
  $file = Join-Path $Root "$Name.ps1"
  Set-Content -Path $file -Value $Script -Encoding UTF8
  $out = Join-Path $Evidence "$Name.out.log"
  $task = "genex-canary-$Name"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -WorkingDirectory $Root `
    -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"& '$file' *> '$out'; exit `$LASTEXITCODE`""
  $principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$UserName" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $TimeoutMinutes) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $task
  $deadline = (Get-Date).AddMinutes($TimeoutMinutes + 1)
  do { Start-Sleep -Seconds 5 } while ((Get-ScheduledTask -TaskName $task).State -eq "Running" -and (Get-Date) -lt $deadline)
  $code = (Get-ScheduledTaskInfo -TaskName $task).LastTaskResult
  Unregister-ScheduledTask -TaskName $task -Confirm:$false
  return $code
}

$src = Join-Path $Work "src"
$release = if ($ReleaseSrc) { Join-Path $Work "release-src" } else { "" }
$profileScript = @"
`$ErrorActionPreference = 'Stop'
& '$Node' '$src\scripts\canary\lived-in-profile.ts' --home `$env:USERPROFILE --files $Files --force-own-home
exit `$LASTEXITCODE
"@
# What a step as the account printed, both streams, into this job's log.
function Show-Output([string] $Name) {
  foreach ($file in @("$Name.out.log", "$Name.out.log.err")) {
    Get-Content (Join-Path $Evidence $file) -ErrorAction SilentlyContinue | Write-Host
  }
}

$code = Invoke-AsUser $profileScript "profile"
Write-Host "lived-in profile for ${UserName}: exit $code"
Show-Output "profile"

# As a person: their own download in their own Downloads folder.
$downloads = Join-Path "C:\Users\$UserName" "Downloads"
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
Copy-Item $Package (Join-Path $downloads "Genex-Setup.exe") -Force
icacls $downloads /grant "${UserName}:(OI)(CI)M" /T /C /Q | Out-Null

$releaseArg = if ($release) { "--release-src '$release'" } else { "" }
$canary = @"
& '$Node' '$src\scripts\canary\run.ts' --machine '$Machine' --kind exe --tag '$Tag' --persona standard-user ``
  --package '$downloads\Genex-Setup.exe' --evidence '$Evidence' $releaseArg
exit `$LASTEXITCODE
"@
$code = Invoke-AsUser $canary "standard-user"
Show-Output "standard-user"
exit $code
