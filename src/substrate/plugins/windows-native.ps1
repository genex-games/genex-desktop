# The trusted host compiles its own launcher with Windows' built-in .NET runtime.
# The native child receives no PowerShell script or compiler access from this directory.
param([Parameter(Mandatory=$true)][string]$SpecFile, [switch]$CleanupOnly)
$control = [System.IO.Path]::GetDirectoryName($SpecFile)
[System.IO.File]::WriteAllText([System.IO.Path]::Combine($control, 'bootstrap.entered'), 'entered')
$ErrorActionPreference = 'Stop'
# Automatic command discovery scans the host's module folders and can stall a cold broker.
# Load only the Windows modules used here, by their built-in paths; no user module is searched.
$PSModuleAutoLoadingPreference = 'None'
Import-Module -Name ([System.IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'))
Import-Module -Name ([System.IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1'))
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    [System.IO.File]::WriteAllText([System.IO.Path]::Combine($control, 'compiler.entered'), 'entered')
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-native.cs')
    [System.IO.File]::WriteAllText([System.IO.Path]::Combine($control, 'compiler.ready'), 'ready')
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
