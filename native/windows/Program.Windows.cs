// @arch docs/features/wechat-rpa/windows-runtime.md
// @test src/__tests__/wechat-channel-windows-helper-source.test.ts

using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Text;
using System.Text.Json;

namespace UseChat.WeChatChannel.Helper.Win;

internal static partial class Program
{
    private static ProcessSnapshot[] FindWeChatProcesses()
        => Process.GetProcesses()
            .Select(ProcessSnapshot.TryFrom)
            .Where(static process => process is not null && process.ProcessName is "Weixin" or "WeChat" or "WeChatAppEx")
            .Cast<ProcessSnapshot>()
            .OrderBy(static process => process.ProcessName)
            .ThenBy(static process => process.ProcessId)
            .ToArray();

    private static WindowSnapshot[] ListWeChatWindows()
        => ListWeChatWindows(FindWeChatProcesses(), out _);

    private static WindowSnapshot[] ListWeChatWindows(ProcessSnapshot[] processes, out ListWeChatWindowsTimings timings)
    {
        var pidToName = new Dictionary<int, string>(processes.Length);
        foreach (var process in processes) pidToName[process.ProcessId] = process.ProcessName;
        var rootsStarted = DateTimeOffset.UtcNow;
        var roots = WeChatProcessRoots(processes, out var readParentProcessMs);
        var rootsMs = ElapsedMs(rootsStarted);
        var windows = new List<WindowSnapshot>();
        var zOrder = 0;
        double readWindowTextMs = 0;
        double readClassNameMs = 0;
        var enumStarted = DateTimeOffset.UtcNow;
        EnumWindows((handle, _) =>
        {
            var currentZOrder = zOrder++;
            if (!IsWindow(handle)) return true;
            GetWindowThreadProcessId(handle, out var processId);
            if (!pidToName.TryGetValue((int)processId, out var processName)) return true;
            if (!GetWindowRect(handle, out var rect)) return true;
            if (!IsWindow(handle)) return true;
            var root = roots.GetValueOrDefault(
                (int)processId,
                (RootProcessId: (int)processId, RootProcessName: processName));
            var textStarted = DateTimeOffset.UtcNow;
            var text = ReadWindowText(handle);
            readWindowTextMs += ElapsedMs(textStarted);
            var classStarted = DateTimeOffset.UtcNow;
            var className = ReadClassName(handle);
            readClassNameMs += ElapsedMs(classStarted);
            windows.Add(new WindowSnapshot(
                handle,
                (int)processId,
                processName,
                text,
                className,
                IsWindowVisible(handle),
                IsIconic(handle),
                Bounds.FromRect(rect),
                root.RootProcessId,
                root.RootProcessName,
                currentZOrder));
            return true;
        }, IntPtr.Zero);
        var enumMs = ElapsedMs(enumStarted);
        var sorted = windows
            .OrderByDescending(static window => IsCaptureCandidate(window))
            .ThenByDescending(static window => IsRestoreCandidate(window))
            .ThenBy(static window => IsPrimaryWeChatShellWindow(window) ? 0 : 1)
            .ThenBy(static window => window.ZOrder)
            .ToArray();
        timings = new ListWeChatWindowsTimings(enumMs, readWindowTextMs, readClassNameMs, rootsMs, readParentProcessMs, windows.Count);
        return sorted;
    }

    private readonly record struct ListWeChatWindowsTimings(
        double enumWindowsMs,
        double readWindowTextMs,
        double readClassNameMs,
        double rootsMs,
        double readParentProcessMs,
        int wechatWindowMatches);

    private static object EnumerateWindows(JsonElement parameters)
    {
        var limit = (int)(ReadInt64(parameters, "limit") ?? 80);
        var includeTitles = ReadBool(parameters, "includeTitles") ?? false;
        var windows = EnumerateRawWindows(limit, includeTitles);

        return new
        {
            limit,
            includeTitles,
            count = windows.Length,
            windows,
        };
    }

    private static RawWindowSnapshot[] EnumerateRawWindows(int limit, bool includeTitles)
    {
        var windows = new List<RawWindowSnapshot>();
        var zOrder = 0;
        EnumWindows((handle, _) =>
        {
            var currentZOrder = zOrder++;
            if (windows.Count >= limit) return false;
            if (!IsWindow(handle)) return true;
            GetWindowThreadProcessId(handle, out var processId);
            if (!GetWindowRect(handle, out var rect)) return true;
            if (!IsWindow(handle)) return true;
            windows.Add(new RawWindowSnapshot(
                handle.ToInt64(),
                (int)processId,
                ReadProcessName((int)processId),
                includeTitles ? ReadWindowText(handle) : "",
                ReadClassName(handle),
                IsWindowVisible(handle),
                Bounds.FromRect(rect),
                currentZOrder));
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    private static WindowSnapshot? SelectBestWindow()
    {
        var windows = ListWeChatWindows();
        return windows.FirstOrDefault(IsCaptureCandidate)
            ?? windows.FirstOrDefault(IsRestoreCandidate);
    }

    private static WindowSnapshot? SelectBestRestorableWindow()
    {
        var windows = ListWeChatWindows();
        return windows.FirstOrDefault(IsRestoreCandidate);
    }

    private static WindowSnapshot? SelectRequestedOrRestorableWindow(JsonElement parameters)
    {
        var handle = ReadInt64(parameters, "handle") ?? ReadWindowId(parameters);
        var windows = ListWeChatWindows();
        if (handle is not null)
        {
            return windows.FirstOrDefault(window => window.Handle == handle.Value);
        }
        return windows.FirstOrDefault(IsRestoreCandidate);
    }

    private static WindowSnapshot? SelectBestRestorableWindowForRecovery()
    {
        var windows = ListWeChatWindows();
        return windows.FirstOrDefault(IsRestoreCandidate);
    }

    // Fast path for EnsureReady: build a WindowSnapshot for the current
    // foreground window without enumerating every top-level window. Returns
    // null on any mismatch so the caller falls back to the full ListWeChatWindows
    // path (cold start, minimized main window, background activation, etc.).
    // Cost: ~5–10ms vs ~1500ms for the full path.
    private static WindowSnapshot? TryFastPathForegroundWeChatWindow(bool activate)
    {
        var handle = GetForegroundWindow();
        if (handle == IntPtr.Zero) return null;
        if (!IsWindow(handle)) return null;
        if (!IsWindowVisible(handle)) return null;
        if (IsIconic(handle)) return null;
        GetWindowThreadProcessId(handle, out var pid);
        if (pid == 0) return null;
        var processName = ReadProcessName((int)pid);
        if (!IsWeChatProcessName(processName)) return null;
        if (!GetWindowRect(handle, out var rect)) return null;
        var text = ReadWindowText(handle);
        var className = ReadClassName(handle);
        var snapshot = new WindowSnapshot(
            handle,
            (int)pid,
            processName,
            text,
            className,
            true,
            false,
            Bounds.FromRect(rect),
            (int)pid,
            processName,
            0);
        if (!IsCaptureCandidate(snapshot)) return null;
        if (IsHungAppWindow(handle)) return null;
        return snapshot;
    }

    private static WindowSnapshot? TrySelectBestRestorableWindowForEnsureReady()
    {
        var windows = ListWeChatWindows();
        var selected = windows.FirstOrDefault(IsCaptureCandidate)
            ?? windows.FirstOrDefault(IsRestoreCandidate);
        var hiddenRestorableWindow = windows.FirstOrDefault(IsHiddenRestorableWindow);
        if (selected is null && hiddenRestorableWindow is not null) return hiddenRestorableWindow;
        return selected;
    }

    private static WindowSnapshot? WaitForRestorableWeChatWindow(TimeSpan timeout)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        do
        {
            var window = SelectBestRestorableWindowForRecovery();
            if (window is not null) return window;
            Thread.Sleep(300);
        } while (DateTimeOffset.UtcNow < deadline);
        return null;
    }

    private static WeChatEntryRecoveryResult TryEnterWeChatFromScreen()
    {
        if (FindWeChatProcesses().Length == 0)
        {
            return new WeChatEntryRecoveryResult(true, false, false, "screen", "wechat_not_running", null, null);
        }

        var screenBounds = AllScreenBounds();
        if (screenBounds.Width <= 0 || screenBounds.Height <= 0)
        {
            return new WeChatEntryRecoveryResult(true, false, false, "screen", "screen_bounds_unavailable", null, null);
        }

        CleanupOverlaysBeforeEntryRecovery();
        using var bitmap = TryCaptureScreenBitmap(screenBounds);
        if (bitmap is null)
        {
            return new WeChatEntryRecoveryResult(true, false, false, "screen", "screen_capture_unavailable", null, null);
        }
        var quality = AnalyzeBitmap(bitmap);
        if (!quality.NonBlank)
        {
            return new WeChatEntryRecoveryResult(true, false, false, "screen", "screen_capture_blank", null, null);
        }

        var tempDir = Path.Combine(Path.GetTempPath(), "shennian-wechat-channel-entry-recovery");
        Directory.CreateDirectory(tempDir);
        var imagePath = Path.Combine(tempDir, $"{Guid.NewGuid():N}.png");
        var preserveDebugImage = false;
        try
        {
            bitmap.Save(imagePath, ImageFormat.Png);
            var greenCandidate = TryFindEnterWeChatButtonByGreenRegion(bitmap);
            if (greenCandidate is not null)
            {
                return ClickEntryCandidate(screenBounds, greenCandidate);
            }

            var ocrCandidate = TryFindEnterWeChatButtonByOcr(imagePath, out var loginRequiredText);
            if (ocrCandidate is not null)
            {
                return ClickEntryCandidate(screenBounds, ocrCandidate);
            }
            if (loginRequiredText)
            {
                return new WeChatEntryRecoveryResult(true, false, true, "ocr", "wechat_login_required", null, null);
            }

            var debugJsonPath = "";
            if (EntryRecoveryDebugEnabled())
            {
                preserveDebugImage = true;
                debugJsonPath = WriteEntryRecoveryDebugJson(imagePath);
            }
            return new WeChatEntryRecoveryResult(
                true,
                false,
                false,
                "screen",
                preserveDebugImage
                    ? $"entry_button_not_found;debugImagePath={imagePath};debugJsonPath={debugJsonPath}"
                    : "entry_button_not_found",
                null,
                null,
                preserveDebugImage ? imagePath : null);
        }
        finally
        {
            if (!preserveDebugImage)
            {
                try { File.Delete(imagePath); } catch { }
            }
        }
    }

    private static bool EntryRecoveryDebugEnabled()
        => string.Equals(Environment.GetEnvironmentVariable("SHENNIAN_WECHAT_ENTRY_RECOVERY_DEBUG"), "1", StringComparison.Ordinal);

    private static string WriteEntryRecoveryDebugJson(string imagePath)
    {
        var debugJsonPath = Path.ChangeExtension(imagePath, ".json");
        var payload = new
        {
            imagePath,
            foreground = GetForegroundWindowSnapshot(),
            processes = FindWeChatProcesses(),
            wechatWindows = ListWeChatWindows(),
            rawWindows = EnumerateRawWindows(200, true),
        };
        File.WriteAllText(debugJsonPath, JsonSerializer.Serialize(payload, JsonOptions));
        return debugJsonPath;
    }

    private static WeChatLaunchRecoveryResult TryLaunchWeChatFromKnownProcess()
    {
        var launchPath = FindWeChatProcesses()
            .Where(static process => process.ProcessName is "Weixin" or "WeChat")
            .Select(static process => process.MainModulePath)
            .FirstOrDefault(static path => !string.IsNullOrWhiteSpace(path) && File.Exists(path));
        if (string.IsNullOrWhiteSpace(launchPath))
        {
            return new WeChatLaunchRecoveryResult(false, "wechat_launch_path_not_found", null, null);
        }

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = launchPath,
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(launchPath) ?? Environment.CurrentDirectory,
            });
            Thread.Sleep(1200);
            return new WeChatLaunchRecoveryResult(true, "wechat_process_started", launchPath, null);
        }
        catch (Exception error)
        {
            return new WeChatLaunchRecoveryResult(false, "wechat_process_start_failed", launchPath, error.Message);
        }
    }

    private static void CleanupOverlaysBeforeEntryRecovery()
    {
        try
        {
            using var parameters = JsonDocument.Parse("""{"includeGeneratedMediaPreviews":true,"includeToolingTerminals":true,"waitMs":220}""");
            _ = CleanupSafeOverlays(parameters.RootElement);
        }
        catch
        {
            // Entry recovery must remain best-effort; failure to close an overlay
            // should become "entry_button_not_found", not a hard crash.
        }
    }

    private static WeChatEntryRecoveryResult ClickEntryCandidate(Bounds screenBounds, EntryButtonCandidate candidate)
    {
        var screenPoint = new Point(
            screenBounds.X + candidate.Bbox.X + candidate.Bbox.Width / 2,
            screenBounds.Y + candidate.Bbox.Y + candidate.Bbox.Height / 2);
        ClickScreenPoint(screenPoint, rightButton: false);
        JitteredSleep(700, 0.20);
        return new WeChatEntryRecoveryResult(
            true,
            true,
            false,
            candidate.Strategy,
            $"clicked:{NormalizeOcrText(candidate.Text)}",
            candidate.Bbox,
            new { x = screenPoint.X, y = screenPoint.Y, coordinateSpace = "screen" });
    }

    private static EntryButtonCandidate? TryFindEnterWeChatButtonByOcr(string imagePath, out bool loginRequiredText)
    {
        loginRequiredText = false;
        try
        {
            using var parameters = JsonDocument.Parse("""{"textScore":0.35,"returnWordBox":true,"numThreads":4}""");
            var run = RunOcr(imagePath, parameters.RootElement);
            loginRequiredText = LooksLikeLoginRequiredText(run.Text);
            return run.Blocks
                .SelectMany(static block => new[] { new { Source = "block", block.Text, block.Bbox, Score = ScoreEnterWeChatText(block.Text), Confidence = block.Confidence ?? 0 } }
                    .Concat(block.Words.Select(static word => new { Source = "word", word.Text, word.Bbox, Score = ScoreEnterWeChatText(word.Text), Confidence = word.Confidence })))
                .Where(static candidate => candidate.Score > 0 && candidate.Bbox is not null)
                .OrderByDescending(static candidate => candidate.Score)
                .ThenByDescending(static candidate => candidate.Confidence)
                .Select(static candidate => new EntryButtonCandidate($"ocr:{candidate.Source}", candidate.Text, candidate.Bbox!, candidate.Score))
                .FirstOrDefault();
        }
        catch
        {
            return null;
        }
    }

    private static EntryButtonCandidate? TryFindEnterWeChatButtonByGreenRegion(Bitmap bitmap)
    {
        var components = new List<Bounds>();
        var minY = Math.Max(0, bitmap.Height / 3);
        for (var y = minY; y < bitmap.Height; y += 1)
        {
            var runStart = -1;
            for (var x = 0; x <= bitmap.Width; x += 1)
            {
                var green = x < bitmap.Width && LooksLikeWeChatGreen(bitmap.GetPixel(x, y));
                if (green && runStart < 0)
                {
                    runStart = x;
                }
                if ((!green || x == bitmap.Width) && runStart >= 0)
                {
                    var runWidth = x - runStart;
                    if (runWidth >= 90)
                    {
                        MergeGreenRun(components, new Bounds(runStart, y, runWidth, 1));
                    }
                    runStart = -1;
                }
            }
        }

        return components
            .Where(static bounds => bounds.Width >= 150
                && bounds.Width <= 460
                && bounds.Height >= 28
                && bounds.Height <= 90
                && bounds.Width / (double)Math.Max(1, bounds.Height) >= 3.0)
            .OrderByDescending(static bounds => bounds.Width * bounds.Height)
            .Select(static bounds => new EntryButtonCandidate("green-button", "进入微信", bounds, 70))
            .FirstOrDefault();
    }

    private static void MergeGreenRun(List<Bounds> components, Bounds run)
    {
        for (var index = 0; index < components.Count; index += 1)
        {
            var current = components[index];
            var overlaps = run.X <= current.X + current.Width + 8
                && current.X <= run.X + run.Width + 8;
            var adjacent = run.Y <= current.Y + current.Height + 2;
            if (!overlaps || !adjacent) continue;
            var left = Math.Min(current.X, run.X);
            var top = Math.Min(current.Y, run.Y);
            var right = Math.Max(current.X + current.Width, run.X + run.Width);
            var bottom = Math.Max(current.Y + current.Height, run.Y + run.Height);
            components[index] = new Bounds(left, top, right - left, bottom - top);
            return;
        }
        components.Add(run);
    }

    private static bool LooksLikeWeChatGreen(Color color)
        => color.G >= 150
            && color.R <= 90
            && color.B >= 50
            && color.B <= 180
            && color.G - color.R >= 70
            && color.G - color.B >= 30;

    private static int ScoreEnterWeChatText(string text)
    {
        var normalized = NormalizeOcrText(text);
        if (normalized.Contains("进入微信", StringComparison.Ordinal)) return 100;
        if (normalized.Contains("進入微信", StringComparison.Ordinal)) return 98;
        if (normalized.Contains("进入", StringComparison.Ordinal) && normalized.Contains("微信", StringComparison.Ordinal)) return 90;
        if (normalized.Contains("进人微信", StringComparison.Ordinal)) return 86;
        var expected = new[] { '进', '入', '微', '信' };
        var position = -1;
        var hits = 0;
        foreach (var item in expected)
        {
            var next = normalized.IndexOf(item, position + 1);
            if (next < 0) continue;
            hits += 1;
            position = next;
        }
        return hits >= 3 ? hits * 18 : 0;
    }

    private static bool LooksLikeLoginRequiredText(string text)
    {
        var normalized = NormalizeOcrText(text);
        return normalized.Contains("扫码登录", StringComparison.Ordinal)
            || normalized.Contains("重新登录", StringComparison.Ordinal)
            || normalized.Contains("登录微信", StringComparison.Ordinal)
            || normalized.Contains("安全验证", StringComparison.Ordinal)
            || normalized.Contains("仅传输文件", StringComparison.Ordinal) && !normalized.Contains("进入微信", StringComparison.Ordinal);
    }

    private static string NormalizeOcrText(string text)
    {
        var builder = new StringBuilder(text.Length);
        foreach (var ch in text)
        {
            if (char.IsWhiteSpace(ch) || ch is ':' or '：' or ',' or '，' or '.' or '。' or '_' or '-' or '—' or '|' or '/' or '\\') continue;
            builder.Append(char.ToLowerInvariant(ch));
        }
        return builder.ToString();
    }

    private static Bounds AllScreenBounds()
    {
        var screens = Screen.AllScreens;
        if (screens.Length == 0) return new Bounds(0, 0, 0, 0);
        var left = screens.Min(static screen => screen.Bounds.Left);
        var top = screens.Min(static screen => screen.Bounds.Top);
        var right = screens.Max(static screen => screen.Bounds.Right);
        var bottom = screens.Max(static screen => screen.Bounds.Bottom);
        return new Bounds(left, top, right - left, bottom - top);
    }

    private static bool IsCaptureCandidate(WindowSnapshot window)
        => window.Visible
            && !window.Minimized
            && IsWeChatAutomationWindow(window);

    private static bool IsRestoreCandidate(WindowSnapshot window)
        => IsWeChatAutomationWindow(window)
            && (window.Minimized || window.Visible);

    private static bool IsWeChatAutomationWindow(WindowSnapshot window)
        => !IsBenignWeChatUtilityWindow(window)
            && (IsWeChatProcessName(window.ProcessName)
                || IsWeChatProcessName(window.RootProcessName));

    private static bool IsHiddenRestorableWindow(WindowSnapshot window)
        => !window.Visible
            && !window.Minimized
            && IsWeChatAutomationWindow(window);

    private static bool IsBenignWeChatUtilityWindow(WindowSnapshot window)
    {
        if (window.Bounds.Width <= 0 || window.Bounds.Height <= 0) return true;
        if (IsWeChatAuxiliaryTitle(window.Title)) return true;
        var className = window.ClassName;
        return className.Contains("QWindowToolSaveBits", StringComparison.OrdinalIgnoreCase)
            || className.Contains("WxTrayIconMessageWindowClass", StringComparison.OrdinalIgnoreCase)
            || className.Contains("Base_PowerMessageWindow", StringComparison.OrdinalIgnoreCase)
            || className.Contains("SystemMessageWindow", StringComparison.OrdinalIgnoreCase)
            || className.Contains("MSCTFIME UI", StringComparison.OrdinalIgnoreCase)
            || className.Equals("IME", StringComparison.OrdinalIgnoreCase)
            || className.Equals("libusb-1.0-windows-hotplug", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsPrimaryWeChatShellWindow(WindowSnapshot window)
        => window.ProcessName is "Weixin" or "WeChat";

    private static bool IsWeChatAuxiliaryTitle(string title)
        => title.Contains("微信发送给", StringComparison.OrdinalIgnoreCase)
            || title.Contains("图片和视频", StringComparison.OrdinalIgnoreCase);

    private static object CurrentSession()
    {
        using var current = Process.GetCurrentProcess();
        var explorerSessions = Process.GetProcessesByName("explorer")
            .Select(TryReadProcessSessionId)
            .Where(static sessionId => sessionId is not null)
            .Select(static sessionId => sessionId!.Value)
            .Distinct()
            .Order()
            .ToArray();
        return new
        {
            processId = Environment.ProcessId,
            sessionId = current.SessionId,
            userName = Environment.UserName,
            sessionName = Environment.GetEnvironmentVariable("SESSIONNAME"),
            explorerSessionIds = explorerSessions,
        };
    }

    private static int? TryReadProcessSessionId(Process process)
    {
        try
        {
            return process.SessionId;
        }
        catch
        {
            return null;
        }
    }

    private static ForegroundWindowSnapshot? GetForegroundWindowSnapshot()
    {
        var handle = GetForegroundWindow();
        if (handle == IntPtr.Zero) return null;
        if (!IsWindow(handle)) return null;
        GetWindowThreadProcessId(handle, out var processId);
        return new ForegroundWindowSnapshot(
            handle.ToInt64(),
            processId,
            ReadProcessName((int)processId),
            ReadWindowText(handle),
            ReadClassName(handle));
    }

    private static bool ForegroundMatches(ForegroundWindowSnapshot? foreground, WindowSnapshot window)
        => foreground is not null && (foreground.Handle == window.Handle || foreground.ProcessId == window.ProcessId);

    // WeChat's anti-RPA scores how often a process yanks itself to the
    // foreground. A real user activates the window once and then types, clicks,
    // and pastes inside it; our pipeline used to re-grab the foreground on every
    // single command (windows.focus, the click, the search, focusMessageInput,
    // then pasteAndSubmit's inner focus) — a 5-6x SetForegroundWindow burst in
    // the few seconds before send, which is the cadence that gets the shell
    // torn down right as it's about to send. EnsureForeground collapses that to
    // at most one real grab: if the target window is already foreground we do
    // nothing, and if it's only minimized we restore without stealing focus
    // again. Each command still calls this, but only the first one that finds
    // the window in the background actually grabs.
    private static bool EnsureForeground(WindowSnapshot window)
    {
        var foreground = GetForegroundWindowSnapshot();
        if (ForegroundMatches(foreground, window) && !window.Minimized)
        {
            // Already the active window — touching SetForegroundWindow here is
            // pure fingerprint with no benefit.
            return false;
        }
        if (window.Minimized || !window.Visible)
        {
            ShowWindow(window.RawHandle, ShowRestore);
        }
        SetForegroundWindow(window.RawHandle);
        JitteredSleep(120);
        return true;
    }

    // Same foreground-grab dedup as EnsureForeground, but for callers that only
    // hold a raw HWND (e.g. mouse.click resolving a windowId off the wire)
    // rather than a full WindowSnapshot. If the handle is already foreground —
    // either the exact window or another window in the same process — skip the
    // grab; that's the common case once a conversation is open and every
    // subsequent click lands on a window that's already up front.
    private static bool EnsureForegroundHandle(IntPtr handle)
    {
        if (handle == IntPtr.Zero) return false;
        var foreground = GetForegroundWindow();
        if (foreground == handle)
        {
            return false;
        }
        if (foreground != IntPtr.Zero)
        {
            GetWindowThreadProcessId(foreground, out var foregroundPid);
            GetWindowThreadProcessId(handle, out var targetPid);
            if (foregroundPid != 0 && foregroundPid == targetPid && !IsIconic(handle))
            {
                return false;
            }
        }
        if (IsIconic(handle))
        {
            ShowWindow(handle, ShowRestore);
        }
        SetForegroundWindow(handle);
        JitteredSleep(120);
        return true;
    }

    private static string ReadProcessName(int processId)
    {
        try
        {
            return Process.GetProcessById(processId).ProcessName;
        }
        catch
        {
            return "";
        }
    }

    private static Dictionary<int, (int RootProcessId, string RootProcessName)> WeChatProcessRoots()
        => WeChatProcessRoots(FindWeChatProcesses(), out _);

    private static Dictionary<int, (int RootProcessId, string RootProcessName)> WeChatProcessRoots(
        ProcessSnapshot[] processes,
        out double readParentProcessMs)
    {
        readParentProcessMs = 0;
        var snapshots = new Dictionary<int, (int Id, string ProcessName, int? ParentProcessId)>(processes.Length);
        foreach (var process in processes)
        {
            var parentStarted = DateTimeOffset.UtcNow;
            var parentId = ReadParentProcessId(process.ProcessId);
            readParentProcessMs += ElapsedMs(parentStarted);
            snapshots[process.ProcessId] = (process.ProcessId, process.ProcessName, parentId);
        }
        var result = new Dictionary<int, (int RootProcessId, string RootProcessName)>();
        foreach (var process in snapshots.Values)
        {
            var root = process;
            var seen = new HashSet<int> { process.Id };
            while (root.ParentProcessId is int parentId
                && snapshots.TryGetValue(parentId, out var parent)
                && seen.Add(parent.Id))
            {
                root = parent;
            }
            result[process.Id] = (root.Id, root.ProcessName);
        }
        return result;
    }

    // NtQueryInformationProcess is a native NT kernel call: sub-millisecond,
    // no COM/RPC hop, and no dependency on the WMI provider service. WMI
    // (`SELECT ParentProcessId FROM Win32_Process`) costs 90-200ms per call
    // because every query round-trips through WmiPrvSE.exe, and permissions.check
    // fires ~15 of these per WeChat process tree — ~1400ms per probe.
    // We fall back to WMI only when the NT call fails (e.g. no
    // PROCESS_QUERY_LIMITED_INFORMATION handle for that pid), preserving
    // legacy behavior instead of throwing. Env
    // SHENNIAN_WECHAT_HELPER_PARENT_PROCESS_WMI=1 forces the WMI path for
    // debugging.
    private static int? ReadParentProcessId(int processId)
    {
        if (Environment.GetEnvironmentVariable("SHENNIAN_WECHAT_HELPER_PARENT_PROCESS_WMI") != "1")
        {
            var fromNt = TryReadParentProcessIdViaNt(processId);
            if (fromNt is not null) return fromNt;
        }
        return TryReadParentProcessIdViaWmi(processId);
    }

    private static int? TryReadParentProcessIdViaNt(int processId)
    {
        var handle = IntPtr.Zero;
        try
        {
            handle = OpenProcess(ProcessQueryLimitedInformation, false, processId);
            if (handle == IntPtr.Zero) return null;
            var info = new ProcessBasicInformation();
            var size = System.Runtime.InteropServices.Marshal.SizeOf<ProcessBasicInformation>();
            var status = NtQueryInformationProcess(handle, 0, ref info, (uint)size, out _);
            if (status != 0) return null;
            var parent = info.InheritedFromUniqueProcessId.ToInt64();
            if (parent <= 0 || parent > int.MaxValue) return null;
            return (int)parent;
        }
        catch
        {
            return null;
        }
        finally
        {
            if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }

    private static int? TryReadParentProcessIdViaWmi(int processId)
    {
        try
        {
            using var searcher = new System.Management.ManagementObjectSearcher(
                $"SELECT ParentProcessId FROM Win32_Process WHERE ProcessId = {processId}");
            foreach (var item in searcher.Get())
            {
                return Convert.ToInt32(item["ParentProcessId"]);
            }
        }
        catch
        {
            return null;
        }
        return null;
    }

    private static double? GetLastInputSecondsAgo()
    {
        return SecondsAgoForTick(GetLastInputTick());
    }

    private static double? SecondsAgoForTick(long? tick)
    {
        if (tick is null) return null;
        var elapsedMs = Environment.TickCount64 - tick.Value;
        if (elapsedMs < 0) return null;
        return Math.Round(elapsedMs / 1000.0, 3);
    }

    private static long? GetLastInputTick()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<LASTINPUTINFO>() };
        return GetLastInputInfo(ref info) ? info.dwTime : null;
    }

    private static bool IsNonBlank(Bitmap bitmap)
    {
        return AnalyzeBitmap(bitmap).NonBlank;
    }

    private static Bitmap CaptureBitmap(IntPtr hwnd, int width, int height, out string captureMethod)
    {
        if (!IsIconic(hwnd) && GetWindowRect(hwnd, out var visibleRect)
            && visibleRect.Right > visibleRect.Left
            && visibleRect.Bottom > visibleRect.Top)
        {
            var screen = CaptureScreenBitmap(Bounds.FromRect(visibleRect));
            var screenQuality = AnalyzeBitmap(screen);
            if (screenQuality.NonBlank)
            {
                captureMethod = "copyFromScreen";
                return screen;
            }
            screen.Dispose();
        }

        var printWindow = CapturePrintWindowBitmap(hwnd, width, height);
        if (printWindow is not null)
        {
            var quality = AnalyzeBitmap(printWindow);
            if (quality.NonBlank)
            {
                captureMethod = "printWindow";
                return printWindow;
            }
            printWindow.Dispose();
        }

        var bitBlt = CaptureWindowDcBitmap(hwnd, width, height);
        var bitBltQuality = AnalyzeBitmap(bitBlt);
        if (bitBltQuality.NonBlank)
        {
            captureMethod = "bitBltAfterBlankPrintWindow";
            return bitBlt;
        }
        bitBlt.Dispose();

        if (GetWindowRect(hwnd, out var rect))
        {
            var screen = CaptureScreenBitmap(Bounds.FromRect(rect));
            var screenQuality = AnalyzeBitmap(screen);
            captureMethod = screenQuality.NonBlank
                ? "copyFromScreenAfterBlankPrintWindow"
                : "copyFromScreenBlankAfterPrintWindowAndBitBlt";
            return screen;
        }

        captureMethod = "bitBltBlankAfterPrintWindow";
        return CaptureWindowDcBitmap(hwnd, width, height);
    }

    private static Bitmap? CapturePrintWindowBitmap(IntPtr hwnd, int width, int height)
    {
        var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using var graphics = Graphics.FromImage(bitmap);
        var hdcDest = graphics.GetHdc();
        try
        {
            if (PrintWindow(hwnd, hdcDest, PrintWindowRenderFullContent)) return bitmap;
            bitmap.Dispose();
            return null;
        }
        finally
        {
            graphics.ReleaseHdc(hdcDest);
        }
    }

    private static Bitmap CaptureWindowDcBitmap(IntPtr hwnd, int width, int height)
    {
        var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using var graphics = Graphics.FromImage(bitmap);
        var hdcDest = graphics.GetHdc();
        try
        {
            var hdcSrc = GetWindowDC(hwnd);
            try
            {
                if (hdcSrc == IntPtr.Zero) throw new HelperException("capture_failed", "Cannot get window device context");
                if (!BitBlt(hdcDest, 0, 0, width, height, hdcSrc, 0, 0, SrcCopy))
                {
                    throw new HelperException("capture_failed", "BitBlt failed");
                }
                return bitmap;
            }
            finally
            {
                if (hdcSrc != IntPtr.Zero) ReleaseDC(hwnd, hdcSrc);
            }
        }
        finally
        {
            graphics.ReleaseHdc(hdcDest);
        }
    }

    private static Bitmap CaptureScreenBitmap(Bounds bounds)
    {
        var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
        using var graphics = Graphics.FromImage(bitmap);
        graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, new Size(bounds.Width, bounds.Height), CopyPixelOperation.SourceCopy);
        return bitmap;
    }

    private static Bitmap? TryCaptureScreenBitmap(Bounds bounds)
    {
        try
        {
            return CaptureScreenBitmap(bounds);
        }
        catch
        {
            return null;
        }
    }

    private static BitmapQuality AnalyzeBitmap(Bitmap bitmap)
    {
        var width = bitmap.Width;
        var height = bitmap.Height;
        var samples = 0;
        var varied = 0;
        var bright = 0;
        Color? first = null;
        for (var y = 0; y < height; y += Math.Max(1, height / 24))
        {
            for (var x = 0; x < width; x += Math.Max(1, width / 24))
            {
                var color = bitmap.GetPixel(x, y);
                first ??= color;
                samples++;
                if (ColorDistance(first.Value, color) > 8) varied++;
                if (color.R + color.G + color.B > 90) bright++;
            }
        }
        var variedRatio = samples > 0 ? Math.Round(varied / (double)samples, 4) : 0;
        var brightRatio = samples > 0 ? Math.Round(bright / (double)samples, 4) : 0;
        return new BitmapQuality(samples, variedRatio, brightRatio, samples > 0 && variedRatio >= 0.02 && brightRatio >= 0.02);
    }

    private static int ColorDistance(Color left, Color right)
        => Math.Abs(left.R - right.R) + Math.Abs(left.G - right.G) + Math.Abs(left.B - right.B);

    private static string ReadWindowText(IntPtr handle)
    {
        if (!IsWindow(handle)) return "";
        var builder = new StringBuilder(512);
        try
        {
            _ = GetWindowText(handle, builder, builder.Capacity);
        }
        catch
        {
            return "";
        }
        return builder.ToString();
    }

    private static string ReadClassName(IntPtr handle)
    {
        if (!IsWindow(handle)) return "";
        var builder = new StringBuilder(256);
        try
        {
            _ = GetClassName(handle, builder, builder.Capacity);
        }
        catch
        {
            return "";
        }
        return builder.ToString();
    }
}
