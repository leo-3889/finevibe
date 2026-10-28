param([string]$TmpDir = (Join-Path $env:TEMP ('finevibe-bench-' + [guid]::NewGuid().ToString('N'))))
# Raw Win32 clipboard contention harness (plan section 7 P0-2 Windows cross-check).
# For each scenario, a background powershell holds OpenClipboard for 2.5s
# (hold.ps1) while this process replays the app's 5 x 5ms retry pattern and a
# 100ms/4000ms time-to-acquire quantification loop. Run from an interactive
# desktop session: powershell -NoProfile -ExecutionPolicy Bypass -File clipbench.ps1
# All scratch artifacts (fixture files, holder flag) live under -TmpDir - by
# default a fresh finevibe-bench-<guid> dir in %TEMP% - removed recursively on exit.
$ErrorActionPreference = 'Stop'
Add-Type -Namespace W -Name U32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(System.IntPtr hWndNewOwner);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)] public static extern bool CloseClipboard();
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)] public static extern bool EmptyClipboard();
'@
function Open-Clip { return [W.U32]::OpenClipboard([IntPtr]::Zero) }
function Close-Clip { [void][W.U32]::CloseClipboard() }
function LastErr { return [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Set-Scenario([string]$Scenario) {
  if (-not (Open-Clip)) { throw ("setup OpenClipboard failed win32=" + (LastErr)) }
  [void][W.U32]::EmptyClipboard()
  Close-Clip
  if ($Scenario -eq 'text') { Set-Clipboard -Value ('p0 contention text ' + ('y' * 64)) }
  elseif ($Scenario -eq 'files') { Set-Clipboard -Path $files }
  else { throw ("unknown scenario " + $Scenario) }
}

New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
try {
  $files = @()
  foreach ($i in 1..3) {
    $f = Join-Path $TmpDir ("bench-file-" + $i + ".txt")
    Set-Content -LiteralPath $f -Value ("bench file " + $i)
    $files += $f
  }
  foreach ($scenario in @('text', 'files')) {
    Set-Scenario $scenario
    $flag = Join-Path $TmpDir 'hold.flag'
    Remove-Item -LiteralPath $flag -Force -ErrorAction SilentlyContinue
    $job = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'hold.ps1'), '-Ms', '2500', '-Flag', ('"' + $flag + '"')) -PassThru -WindowStyle Hidden
    # Sync on the holder's acquire sentinel so the loops collide with the hold.
    $waited = 0
    while (-not (Test-Path $flag) -and $waited -lt 10000) { Start-Sleep -Milliseconds 50; $waited += 50 }
    Write-Output ("scenario=" + $scenario + " holder-flag-seen=" + (Test-Path $flag) + " afterMs=" + $waited)
    # 1) The app's pattern: 5 attempts x 5ms sleep (ipc-handlers clipboard retry).
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $acquired = $false
    $lastErr = 0
    for ($i = 0; $i -lt 5; $i++) {
      $acquired = Open-Clip
      if ($acquired) { break }
      $lastErr = LastErr
      Start-Sleep -Milliseconds 5
    }
    $sw.Stop()
    $appMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
    if ($acquired) { Close-Clip }
    $appLine = "scenario=$scenario app-5x5ms acquired=$acquired lastWin32=$lastErr totalMs=$appMs"
    # 2) Quantification: retry every 100ms up to 4000ms.
    $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
    $acq2 = $false
    $attempts = 0
    $tta = -1
    while ($sw2.Elapsed.TotalMilliseconds -lt 4000) {
      $attempts++
      $acq2 = Open-Clip
      if ($acq2) { $tta = [math]::Round($sw2.Elapsed.TotalMilliseconds, 1); Close-Clip; break }
      Start-Sleep -Milliseconds 100
    }
    $sw2.Stop()
    Write-Output $appLine
    Write-Output ("scenario=$scenario quant acquired=$acq2 timeToAcquireMs=$tta attempts=$attempts windowMs=" + [math]::Round($sw2.Elapsed.TotalMilliseconds, 1))
    $job | Wait-Process -Timeout 15 -ErrorAction SilentlyContinue
    if (-not $job.HasExited) { Stop-Process -Id $job.Id -Force -ErrorAction SilentlyContinue }
    $holderState = 'running'
    if ($job.HasExited) { $holderState = 'exited code=' + $job.ExitCode }
    Write-Output ("scenario=" + $scenario + " holder-state: " + $holderState)
  }
  Write-Output 'clipbench.ps1 DONE'
} finally {
  Remove-Item -LiteralPath $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
