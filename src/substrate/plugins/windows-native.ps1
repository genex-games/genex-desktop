# The trusted host compiles its own launcher with Windows' built-in .NET runtime.
# The native child receives no PowerShell script or compiler access from this directory.
param([Parameter(Mandatory=$true)][string]$SpecFile, [switch]$CleanupOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-native.cs')
    $spec = Get-Content -LiteralPath $SpecFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($CleanupOnly) {
        [GenexNative.ContainerJob]::Recover([string]$spec.profile, [string]$spec.control, [string[]](@($spec.reads) + @($spec.writes) + @($spec.denied)))
        exit 0
    }
    $environment = @{}
    foreach ($item in $spec.env.PSObject.Properties) { $environment[$item.Name] = [string]$item.Value }
    $outcome = [GenexNative.ContainerJob]::Run(
        [string]$spec.profile, [string]$spec.binary, [string[]]$spec.args,
        [string]$spec.cwd, [string[]]$spec.reads, [string[]]$spec.writes,
        [string[]]$spec.denied, $environment, [string]$spec.control,
        [int]$spec.parentPid
    )
    $outcome | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $spec.control 'result.json') -Encoding UTF8
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
