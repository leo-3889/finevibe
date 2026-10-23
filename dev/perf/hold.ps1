param([int]$Ms = 2500, [string]$Flag = '')
# Holds the Win32 clipboard open for $Ms ms, modelling rdprclip.exe-style
# contention (todos/clipboard-paste-latency-plan.md section 7, P0-2 Windows).
# A6 temp discipline: writes no fixed %TEMP% paths - the only artifact is the
# caller-supplied -Flag sentinel (clipbench.ps1 keeps it inside its own scratch
# dir); release + flag removal are guaranteed by the finally below.
Add-Type -Namespace W -Name U32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(System.IntPtr hWndNewOwner);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)] public static extern bool CloseClipboard();
'@
function Stamp { return (Get-Date).ToString("HH:mm:ss.fff") }
$acquired = $false
$deadline = (Get-Date).AddSeconds(5)
while (-not $acquired -and (Get-Date) -lt $deadline) {
  $acquired = [W.U32]::OpenClipboard([IntPtr]::Zero)
  if (-not $acquired) { Start-Sleep -Milliseconds 20 }
}
if (-not $acquired) {
  Write-Output ("[" + (Stamp) + "] ACQUIRE-FAILED win32=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  exit 1
}
Write-Output ("[" + (Stamp) + "] ACQUIRED holding " + $Ms + "ms")
if ($Flag -ne '') { Set-Content -LiteralPath $Flag -Value 'acquired' -Encoding ascii }
try {
  Start-Sleep -Milliseconds $Ms
} finally {
  [void][W.U32]::CloseClipboard()
  Write-Output ("[" + (Stamp) + "] RELEASED")
  if ($Flag -ne '') { Remove-Item -LiteralPath $Flag -Force -ErrorAction SilentlyContinue }
}
