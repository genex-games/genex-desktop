# What a Windows machine is doing while a first start runs over its budget, written to
# $env:CANARY_FILE before the app is closed: the busiest processes over ten seconds, the git
# processes Genex started and how much CPU they got, how fast the harness repository grows, what
# Defender and Smart App Control are set to, how long a freshly written file takes to read, and
# how long starting a process takes.
# Each part is reported on its own; one that fails says so and the rest still run.
$ErrorActionPreference = 'Continue'
$out = New-Object System.Collections.Generic.List[string]
$sampleSeconds = 10
$objects = Join-Path $env:CANARY_USERDATA 'workspaces\harness\.git\objects'

function Count-Objects {
  if (-not (Test-Path $objects)) { return -1 }
  (Get-ChildItem -Path $objects -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
}

function Cpu-Table {
  $table = @{}
  foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
    $table[$p.Id] = [pscustomobject]@{ Name = $p.Name; Cpu = [double]$p.CPU }
  }
  $table
}

$objectsBefore = Count-Objects
$before = Cpu-Table
Start-Sleep -Seconds $sampleSeconds
$after = Cpu-Table
$objectsAfter = Count-Objects

$out.Add("== busiest processes over $sampleSeconds s (CPU seconds; $env:NUMBER_OF_PROCESSORS CPUs) ==")
$rows = foreach ($id in $after.Keys) {
  $was = if ($before.ContainsKey($id)) { $before[$id].Cpu } else { 0 }
  [pscustomobject]@{ Id = $id; Name = $after[$id].Name; Seconds = [math]::Round($after[$id].Cpu - $was, 2) }
}
$rows | Sort-Object Seconds -Descending | Select-Object -First 12 | ForEach-Object {
  $out.Add(('{0,8} {1,-28} {2}' -f $_.Seconds, $_.Name, $_.Id))
}

$out.Add('')
$out.Add('== git processes ==')
try {
  $gits = Get-CimInstance Win32_Process -Filter "Name='git.exe'" -ErrorAction Stop
  if (-not $gits) { $out.Add('none') }
  foreach ($g in $gits) {
    $cpu = if ($after.ContainsKey([int]$g.ProcessId)) { $after[[int]$g.ProcessId].Cpu } else { 'gone' }
    $was = if ($before.ContainsKey([int]$g.ProcessId)) { $before[[int]$g.ProcessId].Cpu } else { 'new' }
    $out.Add("pid $($g.ProcessId) parent $($g.ParentProcessId) started $($g.CreationDate) cpu $was -> $cpu s: $($g.CommandLine)")
  }
} catch { $out.Add("could not list: $_") }

$out.Add('')
$out.Add('== harness repository ==')
$out.Add("loose objects: $objectsBefore -> $objectsAfter over $sampleSeconds s (-1: no repository yet)")
$lock = Join-Path $env:CANARY_USERDATA 'workspaces\harness\.git\index.lock'
$out.Add("index.lock: $(if (Test-Path $lock) { 'present' } else { 'absent' })")

$out.Add('')
$out.Add('== Defender and Smart App Control ==')
try {
  $mp = Get-MpComputerStatus -ErrorAction Stop
  $out.Add("real-time: $($mp.RealTimeProtectionEnabled); on-access: $($mp.OnAccessProtectionEnabled); mode: $($mp.AMRunningMode)")
} catch { $out.Add("Defender status unreadable: $_") }
$sac = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState
$out.Add("Smart App Control state: $(if ($null -eq $sac) { 'not set' } else { "$sac (0 off, 1 on, 2 evaluation)" })")

$out.Add('')
$out.Add('== first read of freshly written files ==')
try {
  $dir = Join-Path $env:TEMP ("canary-fresh-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $dir | Out-Null
  $bytes = [Text.Encoding]::UTF8.GetBytes(('export const x = 1;' + "`n") * 200)
  $files = foreach ($i in 1..20) { $f = Join-Path $dir "f$i.ts"; [IO.File]::WriteAllBytes($f, $bytes); $f }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  foreach ($f in $files) { [void][IO.File]::ReadAllBytes($f) }
  $read = $watch.ElapsedMilliseconds
  $watch.Restart()
  foreach ($f in $files) { [void][IO.File]::ReadAllBytes($f) }
  $out.Add("20 files: first read $read ms, second read $($watch.ElapsedMilliseconds) ms")
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
} catch { $out.Add("could not measure: $_") }

$out.Add('')
$out.Add('== starting a process ==')
$times = foreach ($i in 1..3) { (Measure-Command { & cmd.exe /c exit }).TotalMilliseconds }
$out.Add("cmd.exe /c exit: $(($times | ForEach-Object { [math]::Round($_) }) -join ', ') ms")

Set-Content -Path $env:CANARY_FILE -Value $out -Encoding UTF8
