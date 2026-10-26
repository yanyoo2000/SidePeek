# SidePeek E2E —— 浏览器窗口截图（Windows）
# ---------------------------------------------------------------------------
# 为什么需要它：
#   chrome-devtools MCP 的 take_screenshot(filePath) 受宿主机文件沙箱限制
#   （"not within any of the configured workspace roots"），无法把图片落到 docs/qa-assets。
#   而 QA 报告必须引用可复核的截图，所以这里用 Win32 PrintWindow 直接从窗口抓图：
#     - PrintWindow(PW_RENDERFULLCONTENT) 可以在窗口被遮挡时也抓到内容，不抢焦点；
#     - 保留窗口边框与地址栏 —— 地址栏本身就是「顶层 URL 未被劫持」的直接证据。
#
# 用法：
#   pwsh -File tests/e2e/capture-window.ps1 -Title 'Edge' -Out docs/qa-assets/01.png
#   pwsh -File tests/e2e/capture-window.ps1 -Title '哔哩哔哩' -Out out.png -MaxWidth 1600 -Foreground
#
# 参数：
#   -Title       窗口标题子串（区分大小写）或进程名（如 msedge）
#   -Out         输出 PNG 路径
#   -MaxWidth    缩放上限（默认 1600，控制文件体积）
#   -Foreground  先把窗口置前再用屏幕抓取（PrintWindow 抓到黑屏时的兜底）
#
# 退出码：0 成功；1 找不到窗口或抓图失败。

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxWidth = 1600,
  [switch]$Foreground
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

if (-not ('SidePeekCapture.Win32' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace SidePeekCapture {
  public class Win32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public static IntPtr FindByTitle(string needle) {
      IntPtr found = IntPtr.Zero;
      EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
        if (!IsWindowVisible(hWnd)) return true;
        int len = GetWindowTextLength(hWnd);
        if (len <= 0) return true;
        StringBuilder sb = new StringBuilder(len + 1);
        GetWindowText(hWnd, sb, sb.Capacity);
        string title = sb.ToString();
        if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
          found = hWnd;
          return false;
        }
        return true;
      }, IntPtr.Zero);
      return found;
    }

    public static IntPtr FindByProcess(string processName) {
      IntPtr found = IntPtr.Zero;
      System.Diagnostics.Process[] procs = System.Diagnostics.Process.GetProcessesByName(processName);
      foreach (System.Diagnostics.Process p in procs) {
        if (p.MainWindowHandle != IntPtr.Zero) { found = p.MainWindowHandle; break; }
      }
      return found;
    }
  }
}
"@
}

function Get-TargetWindow {
  param([string]$Needle)
  $hwnd = [SidePeekCapture.Win32]::FindByTitle($Needle)
  if ($hwnd -ne [IntPtr]::Zero) { return $hwnd }
  return [SidePeekCapture.Win32]::FindByProcess($Needle)
}

$hwnd = Get-TargetWindow -Needle $Title
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Error "找不到标题包含「$Title」的可见窗口"
  exit 1
}

$rect = New-Object SidePeekCapture.Win32+RECT
[void][SidePeekCapture.Win32]::GetWindowRect($hwnd, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  Write-Error "窗口尺寸非法：${width}x${height}"
  exit 1
}

# 抓图前仅在需要时置前；不调用 SW_RESTORE（它会把最大化窗口缩回普通尺寸，
# 导致拿到的 rect 与实际可见区域不一致 —— 会让截图里混进桌面）。
if ($Foreground) {
  [void][SidePeekCapture.Win32]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 350
  $rect = New-Object SidePeekCapture.Win32+RECT
  [void][SidePeekCapture.Win32]::GetWindowRect($hwnd, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
}

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()

$ok = $false
try {
  if ($Foreground) {
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
    $ok = $true
  }
  else {
    # 2 = PW_RENDERFULLCONTENT（Win8.1+，Chromium 需此标志才能抓到 GPU 合成内容）
    $ok = [SidePeekCapture.Win32]::PrintWindow($hwnd, $hdc, 2)
  }
}
finally {
  $graphics.ReleaseHdc($hdc)
}

# PrintWindow 对少数 GPU 合成场景会返回全黑图（Edge 就属于这种）：
# 抽样判断后自动退回「置前 + 屏幕抓取」。置前后重新取 rect，避免窗口尺寸变化导致错位。
if ($ok) {
  $blackSamples = 0
  for ($x = 20; $x -lt $width; $x += [Math]::Max(40, [int]($width / 8))) {
    for ($y = 20; $y -lt $height; $y += [Math]::Max(40, [int]($height / 8))) {
      $pixel = $bitmap.GetPixel($x, $y)
      if ($pixel.R -lt 8 -and $pixel.G -lt 8 -and $pixel.B -lt 8) { $blackSamples++ }
    }
  }
  if ($blackSamples -gt 8) {
    Write-Warning 'PrintWindow 抓到疑似全黑画面，改用「置前 + 屏幕抓取」'
    $graphics.Dispose()
    $bitmap.Dispose()

    [void][SidePeekCapture.Win32]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 400
    $rect = New-Object SidePeekCapture.Win32+RECT
    [void][SidePeekCapture.Win32]::GetWindowRect($hwnd, [ref]$rect)
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top

    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
    $graphics.Dispose()
  }
}
else {
  Write-Warning 'PrintWindow 失败，改用「置前 + 屏幕抓取」'
  $graphics.Dispose()
  $bitmap.Dispose()

  [void][SidePeekCapture.Win32]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 400
  $rect = New-Object SidePeekCapture.Win32+RECT
  [void][SidePeekCapture.Win32]::GetWindowRect($hwnd, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top

  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
  $graphics.Dispose()
}

# 缩放到 MaxWidth，控制 PNG 体积（截图只需看清布局与文字）
$finalWidth = $width
$finalHeight = $height
if ($MaxWidth -gt 0 -and $width -gt $MaxWidth) {
  $scale = $MaxWidth / $width
  $newWidth = [int]($width * $scale)
  $newHeight = [int]($height * $scale)
  $resized = New-Object System.Drawing.Bitmap $newWidth, $newHeight
  $g2 = [System.Drawing.Graphics]::FromImage($resized)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bitmap, 0, 0, $newWidth, $newHeight)
  $g2.Dispose()
  $bitmap.Dispose()
  $bitmap = $resized
  $finalWidth = $newWidth
  $finalHeight = $newHeight
}

$outFull = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Out))
$outDir = [System.IO.Path]::GetDirectoryName($outFull)
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$bitmap.Save($outFull, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

$size = (Get-Item $outFull).Length
Write-Output "saved $outFull (${width}x${height} -> ${finalWidth}x${finalHeight}, $size bytes)"
