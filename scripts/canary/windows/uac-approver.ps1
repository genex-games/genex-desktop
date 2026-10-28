# Approve each Windows approval (UAC) prompt on the desktop as its owner would, for the canary's
# upgrade mode (azure-vm.ps1 starts it as SYSTEM in the owner's session, in-session.ps1): a test
# cannot click Yes from the account itself, since the prompt runs above it. For each prompt it saves
# a screenshot of the screen, presses Yes, and writes one JSON line to uac.jsonl in `Out`
# (scripts/canary/upgrade.ts reads them). It stops once the file `Stop` exists. The VM shows the
# prompt on the normal desktop (PromptOnSecureDesktop 0), where it can be seen and pressed. Until
# the run writes `prompts-on` in `Out` (right before it presses Update) Windows elevates without
# asking (ConsentPromptBehaviorAdmin 0), so the earlier release's own setup runs as before; then
# this turns the prompt on (5, Windows' default) and writes `prompts-switched`.
param(
  [Parameter(Mandatory)] [string] $Out,
  [Parameter(Mandatory)] [string] $Stop
)
$ErrorActionPreference = "Continue"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$log = Join-Path $Out "uac.jsonl"
$auto = [Windows.Automation.AutomationElement]
$isButton = New-Object Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
# How long a new prompt is given to draw before it is photographed and pressed.
$DrawSeconds = 2
# How long the Yes button is looked for before Alt+Y is sent instead.
$FindSeconds = 15

function Save-Screen([string] $File) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  [System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
  $bitmap.Save($File, [System.Drawing.Imaging.ImageFormat]::Png)
}

# Press Yes in the consent window of process `Id`; how it was pressed, or "" when it was not found.
function Press-Yes([int] $Id) {
  $ofProcess = New-Object Windows.Automation.PropertyCondition($auto::ProcessIdProperty, $Id)
  $deadline = (Get-Date).AddSeconds($FindSeconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($window in $auto::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $ofProcess)) {
      foreach ($button in $window.FindAll([Windows.Automation.TreeScope]::Descendants, $isButton)) {
        if ($button.Current.Name -eq "Yes") {
          $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
          return "pressed Yes"
        }
      }
    }
    Start-Sleep -Milliseconds 500
  }
  return ""
}

$seen = @{}
$count = 0
$policies = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
$promptsOn = Join-Path $Out "prompts-on"
$switched = Join-Path $Out "prompts-switched"
while (-not (Test-Path $Stop)) {
  if ((Test-Path $promptsOn) -and -not (Test-Path $switched)) {
    Set-ItemProperty $policies ConsentPromptBehaviorAdmin 5
    Set-Content -Path $switched -Value (Get-Date).ToUniversalTime().ToString("o")
  }
  foreach ($consent in Get-Process consent -ErrorAction SilentlyContinue) {
    if ($seen.ContainsKey($consent.Id)) { continue }
    $seen[$consent.Id] = $true
    $count++
    $at = (Get-Date).ToUniversalTime().ToString("o")
    Start-Sleep -Seconds $DrawSeconds
    $shot = "uac-$count.png"
    try { Save-Screen (Join-Path $Out $shot) } catch { $shot = "no screenshot: $_" }
    $how = Press-Yes $consent.Id
    if (-not $how) {
      [System.Windows.Forms.SendKeys]::SendWait("%y")
      $how = "sent Alt+Y (no Yes button found)"
    }
    $line = [ordered]@{ n = $count; at = $at; pid = $consent.Id; approved = $how; shot = $shot } | ConvertTo-Json -Compress
    Add-Content -Path $log -Value $line -Encoding UTF8
  }
  Start-Sleep -Milliseconds 300
}
