# Press a button in Genex's window by its name, through UI Automation, as a person's click does:
# the canary's upgrade mode presses the update card's Update (scripts/canary/upgrade.ts). Run as the
# account at the desktop, with CANARY_NAME the button's name and CANARY_SECONDS how long to look.
# Chromium builds its accessibility tree once an automation client asks, so the first passes can
# see the window alone; it asks again until the button is there. Halfway through without one it
# presses Tab and Enter in the window once, as a keyboard reaches the card's one button.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$name = $env:CANARY_NAME
$deadline = (Get-Date).AddSeconds([int]$env:CANARY_SECONDS)
$auto = [Windows.Automation.AutomationElement]
$isButton = New-Object Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
$named = New-Object Windows.Automation.PropertyCondition($auto::NameProperty, $name)
$wanted = New-Object Windows.Automation.AndCondition($isButton, $named)
$windows = 0
$halfway = (Get-Date).AddSeconds([int]$env:CANARY_SECONDS / 2)
$keyed = $false
while ((Get-Date) -lt $deadline) {
  if (-not $keyed -and (Get-Date) -gt $halfway) {
    $keyed = $true
    $front = Get-Process genex -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    $shell = New-Object -ComObject WScript.Shell
    if ($front -and $shell.AppActivate($front.Id)) {
      Start-Sleep -Milliseconds 500
      $shell.SendKeys("{TAB}")
      $shell.SendKeys("{ENTER}")
      Write-Output "pressed Tab and Enter in Genex's window (process $($front.Id)) at $((Get-Date).ToUniversalTime().ToString('o')): no `"$name`" button was readable"
      exit 0
    }
  }
  foreach ($process in Get-Process genex -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }) {
    $windows++
    try {
      $window = $auto::FromHandle($process.MainWindowHandle)
      $button = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $wanted)
      if ($button) {
        $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
        Write-Output "pressed `"$name`" in Genex's window (process $($process.Id)) at $((Get-Date).ToUniversalTime().ToString('o'))"
        exit 0
      }
    } catch {
      # The window can be replaced (the start window by the studio's) while it is read.
    }
  }
  Start-Sleep -Milliseconds 500
}
Write-Output "no `"$name`" button in Genex's window after $env:CANARY_SECONDS s ($windows window reads)"
exit 1
