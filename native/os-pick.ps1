param(
    [string]$BaseUrl = 'http://127.0.0.1:5000',
    [string]$Hotkey = 'Ctrl+Alt+P',
    [int]$PollMs = 35,
    [switch]$Once,
    [switch]$PostOnce,
    [switch]$Select,
    [string]$LockPath = '',
    [string]$Point = '',
    [string]$Language = 'zh',
    [switch]$NoLock
)

# os-pick.ps1 - press the hotkey to enter selection mode: move the pointer to see the
# element under it outlined, click to send it to the DSH host half; right click or Esc
# cancels. Pure ASCII on purpose (Windows PowerShell 5.1 reads a BOM-less file as ANSI).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Single instance across every DSH host on this machine: two helpers would open two
# overlays and swallow each other's clicks. The lock file is held OPEN for the whole
# process lifetime (FileShare.None), so a second helper cannot even read it while the
# owner lives; a file left by a crashed helper is reclaimed.
if ($Point -eq '' -and -not $Once -and -not $PostOnce -and -not $NoLock) {
if ([string]::IsNullOrEmpty($LockPath)) { $LockPath = Join-Path $env:TEMP 'dsh-element-picker.helper.lock' }
$lockPath = $LockPath
$lockStream = $null
for ($attempt = 0; $attempt -lt 4 -and $null -eq $lockStream; $attempt++) {
    try {
        $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    } catch {
        $alive = $true
        try {
            $probe = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
            $reader = New-Object System.IO.StreamReader($probe)
            $raw = $reader.ReadToEnd()
            $reader.Close()
            $probe.Close()
            if ($raw -ne '') {
                $lock = $raw | ConvertFrom-Json
                $holder = Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue
                if ($null -ne $holder -and $holder.StartTime.Ticks -eq [long]$lock.start) { $alive = $true } else { $alive = $false }
            } else {
                $alive = $false
            }
        } catch {
            # Cannot open it: the owner still holds it.
            $alive = $true
        }
        if ($alive) {
            Write-Output 'another helper is already running'
            exit 3
        }
        Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
    }
}
if ($null -eq $lockStream) {
    Write-Output 'could not acquire the helper lock'
    exit 3
}
$payload = ConvertTo-Json @{ pid = $PID; start = (Get-Process -Id $PID).StartTime.Ticks }
$lockBytes = [System.Text.Encoding]::ASCII.GetBytes($payload)
$lockStream.Write($lockBytes, 0, $lockBytes.Length)
$lockStream.Flush()
}
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class OsPickWin32 {
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder name, int max);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    public const uint WM_GETOBJECT = 0x003D;
    public const int OBJID_CLIENT = -4;
    public static IntPtr WindowAt(int x, int y) { POINT p; p.X = x; p.Y = y; return WindowFromPoint(p); }
    public static string ClassOf(IntPtr hWnd) {
        var buffer = new System.Text.StringBuilder(256);
        GetClassName(hWnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }
    public static int ProcessIdOf(IntPtr hWnd) {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        return (int)pid;
    }
    // Chromium keeps its accessibility tree off until a client asks for the window's
    // accessible object; this message is that ask.
    public static void AskAccessible(IntPtr hWnd) {
        SendMessage(hWnd, WM_GETOBJECT, IntPtr.Zero, (IntPtr)OBJID_CLIENT);
    }

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr hWnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    const int WH_MOUSE_LL = 14;
    const int WM_LBUTTONDOWN = 0x0201;
    const int WM_RBUTTONDOWN = 0x0204;
    const uint WM_QUIT = 0x0012;

    public static volatile bool Active;
    public static volatile int X;
    public static volatile int Y;
    public static volatile bool Clicked;
    public static volatile bool Cancelled;

    static HookProc proc;
    static IntPtr hook;
    static Thread thread;
    static uint threadId;

    public static void Start() {
        Cancelled = false;
        Clicked = false;
        Active = true;
        threadId = 0;
        thread = new Thread(Run);
        thread.IsBackground = true;
        thread.Start();
        for (int i = 0; i < 60 && threadId == 0; i++) Thread.Sleep(5);
    }

    static void Run() {
        threadId = GetCurrentThreadId();
        proc = Callback;
        hook = SetWindowsHookEx(WH_MOUSE_LL, proc, IntPtr.Zero, 0);
        MSG msg;
        while (Active && GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        if (hook != IntPtr.Zero) { UnhookWindowsHookEx(hook); hook = IntPtr.Zero; }
        threadId = 0;
    }

    static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0 && Active) {
            try {
                MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                X = data.pt.X;
                Y = data.pt.Y;
                int message = wParam.ToInt32();
                if (message == WM_LBUTTONDOWN) { Clicked = true; return (IntPtr)1; }
                if (message == WM_RBUTTONDOWN) { Cancelled = true; return (IntPtr)1; }
            } catch { }
        }
        return CallNextHookEx(hook, nCode, wParam, lParam);
    }

    public static void Stop() {
        Active = false;
        if (threadId != 0) PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        if (thread != null) { thread.Join(400); thread = null; }
    }
}
'@

# 0x20 = WS_EX_TRANSPARENT: skip hit-testing so UI Automation resolves the app under
# the overlay instead of the overlay itself. 0x80 = WS_EX_TOOLWINDOW.
$WS_EX_TRANSPARENT = 0x20
$WS_EX_TOOLWINDOW = 0x80
$GWL_EXSTYLE = -20
$SWP_FLAGS = 0x0002 -bor 0x0001 -bor 0x0004 -bor 0x0010 -bor 0x0020

function Enable-DpiAwareness {
    try { [void][OsPickWin32]::SetProcessDPIAware() } catch { }
}

function Get-ShortName([string]$programmatic) {
    if ([string]::IsNullOrEmpty($programmatic)) { return '' }
    return ($programmatic -replace '^ControlType\.', '')
}

function Read-Value([System.Windows.Automation.AutomationElement]$element) {
    try {
        $pattern = $null
        $ok = $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)
        if ($ok -and $null -ne $pattern) { return [string]$pattern.Current.Value }
    } catch { }
    return ''
}

function Get-Pick([int]$x, [int]$y) {
    $point = New-Object System.Windows.Point($x, $y)
    $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
    if ($null -eq $element) { return $null }

    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $chain = New-Object System.Collections.ArrayList
    $current = $element
    $top = $element
    for ($i = 0; $i -lt 8 -and $null -ne $current; $i++) {
        $top = $current
        [void]$chain.Add(@{
            name = [string]$current.Current.Name
            controlType = Get-ShortName $current.Current.ControlType.ProgrammaticName
            automationId = [string]$current.Current.AutomationId
        })
        $parent = $walker.GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent
    }

    $bounds = $element.Current.BoundingRectangle
    $topBounds = $top.Current.BoundingRectangle
    $windowOnly = $true
    if ($bounds.Width -gt 0 -and $topBounds.Width -gt 0) {
        $windowOnly = (([math]::Abs($bounds.X - $topBounds.X) -lt 8) -and
                       ([math]::Abs($bounds.Y - $topBounds.Y) -lt 8) -and
                       ([math]::Abs($bounds.Width - $topBounds.Width) -lt 8) -and
                       ([math]::Abs($bounds.Height - $topBounds.Height) -lt 8))
    }

    $processId = $element.Current.ProcessId
    $processName = ''
    $windowTitle = ''
    try {
        $process = Get-Process -Id $processId -ErrorAction Stop
        $processName = $process.ProcessName
        $windowTitle = [string]$process.MainWindowTitle
    } catch { }

    $text = Read-Value $element
    if ([string]::IsNullOrEmpty($text)) { $text = [string]$element.Current.Name }

    return @{
        name = [string]$element.Current.Name
        controlType = Get-ShortName $element.Current.ControlType.ProgrammaticName
        automationId = [string]$element.Current.AutomationId
        className = [string]$element.Current.ClassName
        text = $text
        enabled = [bool]$element.Current.IsEnabled
        processId = $processId
        processName = $processName
        windowTitle = $windowTitle
        windowOnly = $windowOnly
        cursor = @{ x = $x; y = $y }
        bounds = @{ x = [int]$bounds.X; y = [int]$bounds.Y; w = [int]$bounds.Width; h = [int]$bounds.Height }
        chain = @($chain)
    }
}

function Send-Pick($pick) {
    $json = $pick | ConvertTo-Json -Depth 6 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $uri = ($BaseUrl.TrimEnd('/')) + '/element-picker/os/pick'
    Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 5 | Out-Null
}

function Get-CursorPoint {
    $point = New-Object OsPickWin32+POINT
    if (-not [OsPickWin32]::GetCursorPos([ref]$point)) { return $null }
    return @{ x = $point.X; y = $point.Y }
}

# The top-level window under a screen point.
function Get-RootWindow([int]$x, [int]$y) {
    $handle = [OsPickWin32]::WindowAt($x, $y)
    if ($handle -eq [IntPtr]::Zero) { return $null }
    $root = [OsPickWin32]::GetAncestor($handle, 2)  # GA_ROOT
    if ($root -eq [IntPtr]::Zero) { return $handle }
    return $root
}

function Get-WindowTitle([IntPtr]$handle) {
    $buffer = New-Object System.Text.StringBuilder(512)
    [void][OsPickWin32]::GetWindowText($handle, $buffer, $buffer.Capacity)
    return $buffer.ToString()
}

# Ask the host to pick inside the matching browser tab over the DevTools protocol.
function Try-CdpPick([string]$windowTitle) {
    try {
        $payload = ConvertTo-Json @{ windowTitle = $windowTitle }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $uri = ($BaseUrl.TrimEnd('/')) + '/element-picker/os/cdp/pick'
        return Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 100
    } catch {
        return @{ ok = $false; reason = 'cdp-request-failed' }
    }
}
# Ask the host which provider owns a click, and on which side it runs.
function Try-Plan($point, $window) {
    try {
        $payload = ConvertTo-Json @{ point = $point; window = $window } -Depth 5
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $uri = ($BaseUrl.TrimEnd('/')) + '/element-picker/os/plan'
        return Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 6
    } catch {
        return $null
    }
}

# Ask the host to resolve this click through its provider/output engine.
function Try-Resolve($point, $window) {
    try {
        $payload = ConvertTo-Json @{ point = $point; window = $window } -Depth 5
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $uri = ($BaseUrl.TrimEnd('/')) + '/element-picker/os/resolve'
        return Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 120
    } catch {
        return @{ ok = $false; reason = 'resolve-request-failed' }
    }
}

# The outline is four thin topmost windows plus a small hint window. A single
# full-screen layered window with a transparency key is the usual trick, but it costs
# a whole-surface repaint per move and can stall on a multi-monitor setup.
function New-Overlay {
    $accent = [System.Drawing.Color]::FromArgb(255, 76, 141, 255)
    $borders = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt 4; $i++) {
        $form = New-Object System.Windows.Forms.Form
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
        $form.StartPosition = 'Manual'
        $form.ShowInTaskbar = $false
        $form.TopMost = $true
        $form.BackColor = $accent
        $form.Size = New-Object System.Drawing.Size(1, 1)
        $form.Show()
        [void]$borders.Add($form)
    }
    $hintForm = New-Object System.Windows.Forms.Form
    $hintForm.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $hintForm.StartPosition = 'Manual'
    $hintForm.ShowInTaskbar = $false
    $hintForm.TopMost = $true
    $hintForm.BackColor = [System.Drawing.Color]::FromArgb(18, 26, 40)
    $hintLabel = New-Object System.Windows.Forms.Label
    $hintLabel.AutoSize = $true
    $hintLabel.ForeColor = [System.Drawing.Color]::White
    $hintLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $hintLabel.Location = New-Object System.Drawing.Point(6, 4)
    $hintForm.Controls.Add($hintLabel)
    $hintForm.Show()
    return @{ borders = $borders; hint = $hintForm; label = $hintLabel }
}

function Hide-Overlay($overlay) {
    foreach ($form in $overlay.borders) { $form.Visible = $false }
    $overlay.hint.Visible = $false
}

function Close-Overlay($overlay) {
    foreach ($form in $overlay.borders) {
        try { $form.Close() } catch { }
        $form.Dispose()
    }
    try { $overlay.hint.Close() } catch { }
    $overlay.hint.Dispose()
}

function Set-Highlight($overlay, $rect, [string]$label, $previous) {
    $overlay.label.Text = $label
    $size = $overlay.label.PreferredSize
    $overlay.hint.Size = New-Object System.Drawing.Size(($size.Width + 12), ($size.Height + 8))
    if ($null -eq $rect -or $rect.Width -le 0 -or $rect.Height -le 0) {
        foreach ($form in $overlay.borders) { $form.Visible = $false }
        $overlay.hint.Location = New-Object System.Drawing.Point(24, 24)
        $overlay.hint.Visible = $true
        return
    }
    $thickness = 2
    $overlay.borders[0].Bounds = New-Object System.Drawing.Rectangle($rect.X, $rect.Y, $rect.Width, $thickness)
    $overlay.borders[1].Bounds = New-Object System.Drawing.Rectangle($rect.X, ($rect.Y + $rect.Height - $thickness), $rect.Width, $thickness)
    $overlay.borders[2].Bounds = New-Object System.Drawing.Rectangle($rect.X, $rect.Y, $thickness, $rect.Height)
    $overlay.borders[3].Bounds = New-Object System.Drawing.Rectangle(($rect.X + $rect.Width - $thickness), $rect.Y, $thickness, $rect.Height)
    foreach ($form in $overlay.borders) { if (-not $form.Visible) { $form.Visible = $true } }
    $overlay.hint.Location = New-Object System.Drawing.Point([Math]::Max(0, $rect.X), [Math]::Max(0, ($rect.Y - 24)))
    if (-not $overlay.hint.Visible) { $overlay.hint.Visible = $true }
}

function Start-Selection {
    $overlay = New-Overlay
    # Chinese lives as base64 on purpose: Windows PowerShell 5.1 reads a BOM-less file
    # as ANSI, so any non-ASCII literal would arrive as mojibake.
    $hintZh = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('56e75Yqo6byg5qCH5bm254K55Ye76YCJ5Y+WICDCtyAg5Y+z6ZSuIC8gRXNjIOWPlua2iA=='))
    $hint = if ($Language -eq 'en') { 'Move the pointer and click to pick  -  right click / Esc cancels' } else { $hintZh }
    Set-Highlight $overlay $null $hint $null
    [void][OsPickWin32]::Start()

    $hoverRect = $null
    $lastKey = ''
    $ESC = 0x1B
    $result = $null
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $resolvedFor = ''
    $lastPoint = $null
    $lastMoveAt = $stopwatch.ElapsedMilliseconds

    $loopCount = 0
    while ($true) {
        $loopCount += 1
        [System.Windows.Forms.Application]::DoEvents()
        if ([OsPickWin32]::Cancelled) { break }
        if (([OsPickWin32]::GetAsyncKeyState($ESC) -band 0x8000) -ne 0) { break }

        $cursor = Get-CursorPoint
        if ($env:DSH_PICK_DEBUG -and $loopCount -le 3) {
            Write-Output ('iter ' + $loopCount + ' cursor=' + (($cursor | ConvertTo-Json -Compress)) + ' last=' + (($lastPoint | ConvertTo-Json -Compress)))
        }
        if ($null -ne $cursor) {
            $pointKey = '{0}:{1}' -f $cursor.x, $cursor.y
            if ($null -eq $lastPoint -or $lastPoint.x -ne $cursor.x -or $lastPoint.y -ne $cursor.y) {
                $lastPoint = $cursor
                $lastMoveAt = $stopwatch.ElapsedMilliseconds
                # While the pointer travels, keep the previous outline on screen: a fresh
                # AutomationElement.FromPoint can take 50-200 ms on a big window and would
                # make the box lag behind the cursor.
            } elseif ($pointKey -ne $resolvedFor -and ($stopwatch.ElapsedMilliseconds - $lastMoveAt) -ge 70) {
                $resolvedFor = $pointKey
                $pick = Get-Pick $cursor.x $cursor.y
                if ($env:DSH_PICK_DEBUG) { Write-Output ('hover ' + $pointKey + ' null=' + ($null -eq $pick)) }
                if ($null -ne $pick) {
                    $box = $pick.bounds
                    $rect = New-Object System.Drawing.Rectangle($box.x, $box.y, $box.w, $box.h)
                    $label = (($pick.controlType + ' ' + $pick.name) -replace '\s+', ' ').Trim()
                    if ([string]::IsNullOrEmpty($label)) { $label = $pick.processName + ' - ' + $pick.windowTitle }
                    $key = '{0}:{1}:{2}:{3}' -f $box.x, $box.y, $box.w, $box.h
                    if ($key -ne $lastKey) {
                        $lastKey = $key
                        Set-Highlight $overlay $rect $label $hoverRect
                        $hoverRect = $rect
                    }
                }
            }
        }

        if ([OsPickWin32]::Clicked) {
            $cursor = Get-CursorPoint
            if ($null -ne $cursor) {
                Hide-Overlay $overlay
                [System.Windows.Forms.Application]::DoEvents()
                Start-Sleep -Milliseconds 40

                # A browser window cannot answer for its DOM. If it was started with a
                # debugging port, hand the pick to the tab and let it resolve there.
                $root = Get-RootWindow $cursor.x $cursor.y
                $rootClass = if ($null -ne $root) { [OsPickWin32]::ClassOf($root) } else { '' }
                $rootTitle = if ($null -ne $root) { Get-WindowTitle $root } else { '' }
                $rootPid = if ($null -ne $root) { [OsPickWin32]::ProcessIdOf($root) } else { 0 }
                $rootProcess = if ($rootPid -gt 0) { $p = Get-Process -Id $rootPid -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName } else { '' } } else { '' }

                # Fast path: a Chromium window cannot answer for its DOM, so hand that one
                # pick to the tab over CDP (the host queues the result). Everything else is
                # resolved right here with UI Automation - no extra process per click.
                if ($rootClass -match 'Chrome_WidgetWin') {
                    $cdp = Try-CdpPick $rootTitle
                    if ($cdp -and $cdp.ok -eq $true) {
                        $result = $null
                        break
                    }
                    $script:lastResolveReason = if ($cdp) { [string]$cdp.reason } else { 'no-response' }
                }

                $local = Get-Pick $cursor.x $cursor.y
                if ($null -ne $local) {
                    $local['provider'] = 'uia'
                    if ($rootClass -match 'Chrome_WidgetWin' -and $script:lastResolveReason) {
                        $local['cdpReason'] = [string]$script:lastResolveReason
                    }
                }
                $result = $local
            }
            break
        }
        Start-Sleep -Milliseconds $PollMs
        if ($stopwatch.Elapsed.TotalMinutes -gt 3) { break }
    }

    [void][OsPickWin32]::Stop()
    Close-Overlay $overlay
    return $result
}

$wantCtrl = $Hotkey -match '(?i)ctrl'
$wantAlt = $Hotkey -match '(?i)alt'
$wantShift = $Hotkey -match '(?i)shift'
$wantWin = $Hotkey -match '(?i)win'
$keyToken = ($Hotkey -split '\+')[-1].Trim().ToUpperInvariant()
$vk = 0
if ($keyToken.Length -eq 1) { $vk = [int][char]$keyToken }
elseif ($keyToken -match '^F(\d{1,2})$') { $vk = 0x6F + [int]$Matches[1] }
else { throw "Unsupported hotkey key: $keyToken" }

$VK_CONTROL = 0x11
$VK_MENU = 0x12
$VK_SHIFT = 0x10
$VK_LWIN = 0x5B

function Test-Down([int]$vkey) {
    return (([OsPickWin32]::GetAsyncKeyState($vkey) -band 0x8000) -ne 0)
}

# The web client also binds this hotkey while its window has focus. Ask the host so
# exactly one of them opens a picker.
function Test-ClientFocused {
    try {
        $state = Invoke-RestMethod -Method Get -Uri (($BaseUrl.TrimEnd('/')) + '/element-picker/os/state?since=999999') -TimeoutSec 3
        return ($state.clientFocused -eq $true)
    } catch {
        return $false
    }
}

function Test-Hotkey {
    $down = (Test-Down $vk)
    if ($wantCtrl) { $down = $down -and (Test-Down $VK_CONTROL) }
    if ($wantAlt) { $down = $down -and (Test-Down $VK_MENU) }
    if ($wantShift) { $down = $down -and (Test-Down $VK_SHIFT) }
    if ($wantWin) { $down = $down -and (Test-Down $VK_LWIN) }
    return $down
}

Enable-DpiAwareness

if ($Point -ne '') {
    $parts = $Point.Split(',')
    $probe = Get-Pick ([int]$parts[0].Trim()) ([int]$parts[1].Trim())
    if ($null -eq $probe) { Write-Output '{"error":"no element"}'; exit 1 }
    Write-Output ($probe | ConvertTo-Json -Depth 6 -Compress)
    exit 0
}

if ($Once -or $PostOnce) {
    $cursor = Get-CursorPoint
    if ($null -eq $cursor) { Write-Output '{"error":"no cursor"}'; exit 1 }
    $pick = Get-Pick $cursor.x $cursor.y
    if ($null -eq $pick) { Write-Output '{"error":"no element"}'; exit 1 }
    if ($Once) {
        Write-Output ($pick | ConvertTo-Json -Depth 6 -Compress)
        exit 0
    }
    try { Send-Pick $pick; Write-Output 'posted' } catch { Write-Output ('post failed: ' + $_.Exception.Message); exit 1 }
    exit 0
}

if ($Select) {
    Write-Output 'selecting'
    $pick = Start-Selection
    if ($null -eq $pick) { Write-Output 'cancelled'; exit 2 }
    try { Send-Pick $pick; Write-Output ('picked ' + $pick.controlType + ' ' + $pick.name) } catch { Write-Output ('post failed: ' + $_.Exception.Message); exit 1 }
    exit 0
}

Write-Output ('ready hotkey=' + $Hotkey + ' -> ' + $BaseUrl)
$wasDown = $false
while ($true) {
    try {
        $down = Test-Hotkey
        if ($down -and -not $wasDown) {
            $pick = Start-Selection
            if ($null -ne $pick) {
                try {
                    Send-Pick $pick
                    Write-Output ('picked ' + $pick.controlType + ' ' + $pick.name)
                } catch {
                    Write-Output ('post failed: ' + $_.Exception.Message)
                }
            } else {
                Write-Output 'cancelled'
            }
        }
        $wasDown = $down
    } catch {
        Write-Output ('loop error: ' + $_.Exception.Message)
    }
    Start-Sleep -Milliseconds 60
}
