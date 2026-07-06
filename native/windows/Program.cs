// @arch docs/features/wechat-rpa/windows-runtime.md
// @test src/__tests__/wechat-channel-windows-helper-source.test.ts

using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Windows.Forms;

namespace Shennian.WeChatChannel.Helper.Win;

internal static partial class Program
{
    private const string HelperVersion = "0.1.26";
    private const int ProtocolVersion = 1;
    private static readonly DateTimeOffset StartedAt = DateTimeOffset.UtcNow;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
    private static readonly string[] Capabilities =
    [
        "screenCapture",
        "visionOcr",
        "windowList",
        "windowFocus",
        "mouseInput",
        "mouseKeyboard",
        "clipboard",
        "contextMenu",
        "imageCropHash",
        "wechatSearch",
        "wechatHealthProbe",
        "humanActivity",
        "automationLease",
        "overlayCleanup",
        "wechatRecovery",
    ];

    [STAThread]
    private static int Main()
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);
        TryEnableDpiAwareness();

        var helloLine = Console.ReadLine();
        if (string.IsNullOrWhiteSpace(helloLine)) return 2;

        try
        {
            var hello = JsonSerializer.Deserialize<Dictionary<string, object?>>(helloLine, JsonOptions);
            var expectedVersion = GetString(hello, "expectedHelperVersion");
            if (!string.IsNullOrWhiteSpace(expectedVersion) && expectedVersion != HelperVersion)
            {
                WriteJson(new
                {
                    type = "ready",
                    helperVersion = HelperVersion,
                    protocolVersion = ProtocolVersion,
                    capabilities = Capabilities,
                    pid = Environment.ProcessId,
                    warmState = "failed",
                    warmup = new
                    {
                        startedAt = StartedAt,
                        readyAt = DateTimeOffset.UtcNow,
                        coldStartMs = ElapsedMs(StartedAt),
                        errorCode = "helper_version_mismatch",
                        errorSummary = $"Expected {expectedVersion}, got {HelperVersion}",
                    },
                });
                return 3;
            }

            WriteJson(ReadyFrame());
            string? line;
            while ((line = Console.ReadLine()) is not null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                WriteJson(HandleCommand(line));
            }
            return 0;
        }
        catch (Exception error)
        {
            WriteJson(new { ok = false, errorCode = "helper_start_failed", errorSummary = error.Message });
            return 1;
        }
    }

    private static object ReadyFrame() => new
    {
        type = "ready",
        helperVersion = HelperVersion,
        protocolVersion = ProtocolVersion,
        capabilities = Capabilities,
        pid = Environment.ProcessId,
        warmState = "warm",
        warmup = new
        {
            startedAt = StartedAt,
            readyAt = DateTimeOffset.UtcNow,
            coldStartMs = ElapsedMs(StartedAt),
        },
    };

    private static object HandleCommand(string line)
    {
        var started = DateTimeOffset.UtcNow;
        string id = "";
        string? traceId = null;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            id = ReadString(root, "id") ?? Guid.NewGuid().ToString("N");
            traceId = ReadString(root, "traceId");
            var command = ReadString(root, "command") ?? "";
            var result = Execute(command, root.TryGetProperty("params", out var parameters) ? parameters : default);
            return new
            {
                id,
                ok = true,
                result,
                latencyMs = ElapsedMs(started),
                traceId,
                warmState = "warm",
            };
        }
        catch (HelperException error)
        {
            return ErrorResponse(id, error.Code, error.Message, started, traceId);
        }
        catch (Exception error)
        {
            return ErrorResponse(id, "helper_command_failed", error.Message, started, traceId);
        }
    }

    private static object ErrorResponse(string id, string errorCode, string errorSummary, DateTimeOffset started, string? traceId)
        => new
        {
            id = string.IsNullOrWhiteSpace(id) ? Guid.NewGuid().ToString("N") : id,
            ok = false,
            errorCode,
            errorSummary,
            latencyMs = ElapsedMs(started),
            traceId,
            warmState = "warm",
        };

    private static object Execute(string command, JsonElement parameters)
        => command switch
        {
            "health.check" => Health(),
            "session.info" => CurrentSession(),
            "processes.list" => new { processes = FindWeChatProcesses() },
            "permissions.check" => Permissions(),
            "activity.snapshot" => ActivitySnapshot(),
            "windows.list" => new { windows = ListWeChatWindows() },
            "windows.enumerateRaw" => EnumerateWindows(parameters),
            "windows.minimize" => MinimizeWindow(parameters),
            "windows.closeWindow" => CloseWindow(parameters),
            "windows.cleanupOverlays" => CleanupSafeOverlays(parameters),
            "windows.recoverWeChat" => RecoverWeChat(parameters),
            "windows.ensureReady" => EnsureReady(parameters),
            "windows.capture" => CaptureWindow(parameters),
            "windows.focus" => FocusWindow(parameters),
            "screen.capture" => CaptureScreen(parameters),
            "ocr.recognize" => OcrRecognize(parameters),
            "mouse.click" => MouseClick(parameters, rightButton: false),
            "mouse.rightClick" => MouseClick(parameters, rightButton: true),
            "mouse.scroll" => MouseScroll(parameters),
            "keyboard.type" => KeyboardType(parameters),
            "keyboard.shortcut" => KeyboardShortcut(parameters),
            "keyboard.primeTextPaste" => KeyboardPrimeTextPaste(),
            "clipboard.snapshot" => ClipboardSnapshot(),
            "clipboard.restore" => ClipboardRestore(parameters),
            "clipboard.setText" => ClipboardSetText(parameters),
            "clipboard.setFiles" => ClipboardSetFiles(parameters),
            "clipboard.setImage" => ClipboardSetImage(parameters),
            "clipboard.readFileUrls" => ClipboardReadFileUrls(),
            "clipboard.readAttachment" => ClipboardReadAttachment(),
            "menu.pickItem" => MenuPickItem(parameters),
            "image.cropHash" => ImageCropHash(parameters),
            "wechat.searchConversation" => WeChatSearchConversation(parameters),
            "wechat.focusMessageInput" => WeChatFocusMessageInput(parameters),
            "wechat.pasteAndSubmit" => WeChatPasteAndSubmit(parameters),
            "wechat.healthProbe" => WeChatHealthProbe(parameters),
            "automation.lease.acquire" => AutomationLeaseAcquire(parameters),
            "automation.lease.release" => AutomationLeaseRelease(parameters),
            "automation.lease.status" => AutomationLeaseStatus(),
            "automation.lease.simulateInterruption" => AutomationLeaseSimulateInterruption(parameters),
            _ => throw new HelperException("helper_command_unsupported", $"Unsupported command in Windows spike helper: {command}"),
        };

    private static object Health() => new
    {
        ok = true,
        helperVersion = HelperVersion,
        protocolVersion = ProtocolVersion,
        capabilities = Capabilities,
        pid = Environment.ProcessId,
        uptimeMs = ElapsedMs(StartedAt),
        platform = "win32",
        warmState = "warm",
        noUia = true,
    };

    private static object Permissions()
    {
        var started = DateTimeOffset.UtcNow;
        var processes = FindWeChatProcesses();
        var processesLatencyMs = ElapsedMs(started);
        var windowsStarted = DateTimeOffset.UtcNow;
        var windows = ListWeChatWindows(processes, out var windowsTimings);
        var windowsLatencyMs = ElapsedMs(windowsStarted);
        var candidates = windows.Where(IsCaptureCandidate).ToArray();
        var restorable = windows.Where(IsRestoreCandidate).ToArray();
        var hiddenRestorable = windows.Where(IsHiddenRestorableWindow).ToArray();
        var availableForRestore = restorable.Length > 0 || hiddenRestorable.Length > 0;
        var candidateWindow = restorable.FirstOrDefault() ?? hiddenRestorable.FirstOrDefault();
        var candidateWindowResponsive = candidateWindow is not null
            ? !IsHungAppWindow(candidateWindow.RawHandle)
            : (bool?)null;
        return new
        {
            platform = "win32",
            noUia = true,
            processCount = processes.Length,
            windowCount = windows.Length,
            captureCandidateCount = candidates.Length,
            restoreCandidateCount = restorable.Length,
            hiddenRestoreCandidateCount = hiddenRestorable.Length,
            canEnumerateWindows = true,
            canCaptureWindow = candidates.Length > 0,
            wechatRunning = processes.Length > 0,
            wechatWindowAvailable = availableForRestore,
            wechatMainWindowResponsive = candidateWindowResponsive,
            screenRecording = true,
            accessibility = true,
            automation = true,
            userSession = CurrentSession(),
            timings = new
            {
                processesLatencyMs,
                windowsLatencyMs,
                enumWindowsMs = windowsTimings.enumWindowsMs,
                readWindowTextMs = windowsTimings.readWindowTextMs,
                readClassNameMs = windowsTimings.readClassNameMs,
                rootsMs = windowsTimings.rootsMs,
                readParentProcessMs = windowsTimings.readParentProcessMs,
                wechatWindowMatches = windowsTimings.wechatWindowMatches,
                totalLatencyMs = ElapsedMs(started),
            },
            processes,
            captureCandidates = candidates,
            restoreCandidates = restorable,
            hiddenRestoreCandidates = hiddenRestorable,
        };
    }

    private static object ActivitySnapshot()
    {
        var lastInputTick = GetLastInputTick();
        var lastInputSecondsAgo = SecondsAgoForTick(lastInputTick);
        var automationInputSecondsAgo = SecondsAgoForTick(LastAutomationInputTick());
        var automationOwned = IsLastInputAutomationOwned(lastInputTick);
        var humanInputSecondsAgo = automationOwned ? null : lastInputSecondsAgo;
        var foreground = GetForegroundWindowSnapshot();
        return new
        {
            lastInputSecondsAgo,
            automationInputSecondsAgo,
            automationOwned,
            mouseMovedSecondsAgo = humanInputSecondsAgo,
            keyDownSecondsAgo = humanInputSecondsAgo,
            frontmostApp = foreground,
            permissions = new
            {
                inputSnapshotAvailable = lastInputSecondsAgo is not null,
            },
            privacy = new
            {
                capturesKeyContent = false,
                capturesMousePath = false,
            },
        };
    }

    private static object EnsureReady(JsonElement parameters)
    {
        var activate = ReadBool(parameters, "activate") ?? ReadBool(parameters, "focus") ?? ReadBool(parameters, "restore") ?? false;
        var allowRecovery = ReadBool(parameters, "allowRecovery") ?? false;
        var allowLaunch = ReadBool(parameters, "allowLaunch") ?? false;
        var recovery = WeChatEntryRecoveryResult.NotAttempted;
        // Outer fast path: if !allowRecovery (the common per-command guard case),
        // and the current foreground window is already the WeChat main shell,
        // reuse its snapshot without enumerating every top-level window. The
        // slow path (~1.5s) is preserved for cold starts, minimized/hidden main
        // window, or explicit recovery. Env SHENNIAN_WECHAT_WINDOWS_ENSURE_READY_FAST_PATH=0
        // forces the full path.
        WindowSnapshot? window = null;
        if (!allowRecovery && Environment.GetEnvironmentVariable("SHENNIAN_WECHAT_WINDOWS_ENSURE_READY_FAST_PATH") != "0")
        {
            window = TryFastPathForegroundWeChatWindow(activate);
        }
        window ??= TrySelectBestRestorableWindowForEnsureReady();
        if (window is null && allowRecovery)
        {
            recovery = TryEnterWeChatFromScreen();
            if (recovery.LoginRequired)
            {
                throw new HelperException("wechat_login_required", recovery.Reason);
            }
            if (recovery.Clicked)
            {
                window = WaitForRestorableWeChatWindow(TimeSpan.FromSeconds(8));
            }
            else if (recovery.Reason.StartsWith("entry_button_not_found", StringComparison.Ordinal))
            {
                if (allowLaunch)
                {
                    var launch = TryLaunchWeChatFromKnownProcess();
                    if (launch.Started)
                    {
                        recovery = new WeChatEntryRecoveryResult(
                            true,
                            true,
                            false,
                            "process-start",
                            launch.Reason,
                            null,
                            new { launchPath = launch.LaunchPath });
                        window = WaitForRestorableWeChatWindow(TimeSpan.FromSeconds(8));
                    }
                }
                else
                {
                    recovery = new WeChatEntryRecoveryResult(
                        true,
                        false,
                        false,
                        "process-start",
                        "wechat_launch_not_allowed",
                        null,
                        null);
                }
            }
        }
        if (window is null)
        {
            var processes = FindWeChatProcesses();
            throw new HelperException(
                processes.Length > 0 ? "wechat_window_not_found" : "wechat_not_running",
                recovery.Attempted
                    ? $"No restorable WeChat window found after entry recovery: {recovery.Reason}"
                    : "No restorable WeChat window found");
        }
        var foregroundBefore = GetForegroundWindowSnapshot();
        var restoreRequested = false;
        var focusResult = false;
        if (activate)
        {
            restoreRequested = true;
            // Fast path: within one send every high-level step calls ensureReady
            // and this branch used to unconditionally ShowWindow +
            // SetForegroundWindow + JitteredSleep(120), re-grabbing the
            // foreground and burning 120ms even when WeChat is already up front.
            // EnsureForeground applies the same anti-RPA foreground dedup the
            // rest of the pipeline uses: if the window is already foreground and
            // not minimized it does nothing (no grab, no sleep); otherwise it
            // restores/grabs exactly once. Env SHENNIAN_WECHAT_ENSURE_READY_FAST_PATH=0
            // restores the old unconditional grab.
            if (Environment.GetEnvironmentVariable("SHENNIAN_WECHAT_ENSURE_READY_FAST_PATH") == "0")
            {
                ShowWindow(window.RawHandle, ShowRestore);
                focusResult = SetForegroundWindow(window.RawHandle);
                JitteredSleep(120);
            }
            else
            {
                focusResult = EnsureForeground(window);
            }
        }
        var foregroundAfter = GetForegroundWindowSnapshot();
        return new WindowReadyResult(
            window.WindowId,
            window.ProcessId,
            "WeChat",
            window.Title,
            window.ClassName,
            window.Bounds,
            window.Handle,
            activate,
            allowRecovery,
            allowLaunch,
            new WindowActivationResult(
                activate,
                restoreRequested,
                focusResult,
                ForegroundMatches(foregroundAfter, window),
                foregroundBefore,
                foregroundAfter),
            recovery.Attempted ? recovery : null);
    }

    private sealed record WindowReadyResult(
        string WindowId,
        int ProcessId,
        string AppName,
        string Title,
        string ClassName,
        Bounds Bounds,
        long Handle,
        bool Activated,
        bool AllowRecovery,
        bool AllowLaunch,
        WindowActivationResult Activation,
        WeChatEntryRecoveryResult? EntryRecovery = null);

    private sealed record WindowActivationResult(
        bool Requested,
        bool RestoreRequested,
        bool FocusResult,
        bool ForegroundMatches,
        ForegroundWindowSnapshot? ForegroundBefore,
        ForegroundWindowSnapshot? ForegroundAfter);

    private static object FocusWindow(JsonElement parameters)
    {
        var handle = ReadInt64(parameters, "handle") ?? ReadWindowId(parameters) ?? 0;
        if (handle == 0) throw new HelperException("wechat_window_not_found", "windows.focus requires a window handle or windowId");
        var ptr = new IntPtr(handle);
        var grabbed = EnsureForegroundHandle(ptr);
        var foregroundAfter = GetForegroundWindowSnapshot();
        return new { focused = grabbed || foregroundAfter?.Handle == handle, windowId = handle.ToString(), handle, foregroundAfter };
    }

    private static object CloseWindow(JsonElement parameters)
    {
        var handle = ReadInt64(parameters, "handle") ?? ReadWindowId(parameters)
            ?? throw new HelperException("wechat_window_not_found", "windows.closeWindow requires a window handle or windowId");
        // Only ever close a window we can confirm belongs to WeChat. Resolving
        // against the live WeChat window list means a stray or stale handle from
        // the caller can never WM_CLOSE an unrelated app window.
        var window = ListWeChatWindows().FirstOrDefault(item => item.Handle == handle)
            ?? throw new HelperException("wechat_window_not_found", $"No WeChat window matches handle {handle}");
        // WM_CLOSE is a graceful, user-reversible close (it asks the window to
        // close, same as the title-bar X), not a process kill. Used to drop a
        // duplicate "logged-in welcome window" while keeping the real chat_main.
        var posted = PostMessage(window.RawHandle, WmClose, IntPtr.Zero, IntPtr.Zero);
        JitteredSleep(160);
        var stillPresent = ListWeChatWindows().Any(item => item.Handle == handle);
        return new
        {
            closed = posted && !stillPresent,
            posted,
            stillPresent,
            windowId = window.WindowId,
            handle = window.Handle,
            title = window.Title,
            foregroundAfter = GetForegroundWindowSnapshot(),
        };
    }

    private static object MinimizeWindow(JsonElement parameters)
    {
        var window = SelectBestRestorableWindow() ?? throw new HelperException("wechat_window_not_found", "No restorable WeChat window found");
        ShowWindow(window.RawHandle, ShowMinimize);
        JitteredSleep(120);
        return new
        {
            window,
            minimized = IsIconic(window.RawHandle),
            foregroundAfter = GetForegroundWindowSnapshot(),
        };
    }

    private static object CaptureWindow(JsonElement parameters)
    {
        var handle = ReadInt64(parameters, "handle") ?? ReadWindowId(parameters) ?? SelectBestWindow()?.Handle ?? 0;
        if (handle == 0) throw new HelperException("wechat_window_not_found", "No visible capturable WeChat window found");
        var hwnd = new IntPtr(handle);
        if (!GetWindowRect(hwnd, out var rect)) throw new HelperException("capture_failed", "Cannot read window bounds");
        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) throw new HelperException("capture_failed", "Window bounds are empty");

        using var bitmap = CaptureBitmap(hwnd, width, height, out var captureMethod);
        var quality = AnalyzeBitmap(bitmap);
        if (!quality.NonBlank)
        {
            throw new HelperException("screenshot_blank", $"Window screenshot is blank: method={captureMethod}, varied={quality.VariedRatio}, bright={quality.BrightRatio}");
        }

        using var stream = new MemoryStream();
        bitmap.Save(stream, ImageFormat.Png);
        var bytes = stream.ToArray();
        return new
        {
            handle,
            width,
            height,
            bounds = Bounds.FromRect(rect),
            windowId = handle.ToString(),
            mimeType = "image/png",
            coordinateSpace = "screenshotPixel",
            scaleFactor = 1,
            nonBlank = quality.NonBlank,
            captureMethod,
            quality,
            sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            dataBase64 = Convert.ToBase64String(bytes),
            pngBase64 = Convert.ToBase64String(bytes),
        };
    }

    private static object CaptureScreen(JsonElement parameters)
    {
        var bounds = ReadBounds(parameters, "bounds") ?? ReadBounds(parameters, "region");
        if (bounds is null)
        {
            var x = ReadInt64(parameters, "x");
            var y = ReadInt64(parameters, "y");
            var width = ReadInt64(parameters, "width");
            var height = ReadInt64(parameters, "height");
            if (x is null || y is null || width is null || height is null)
            {
                throw new HelperException("capture_region_missing", "screen.capture requires bounds or x/y/width/height");
            }
            bounds = new Bounds((int)x.Value, (int)y.Value, (int)width.Value, (int)height.Value);
        }
        if (bounds.Width <= 0 || bounds.Height <= 0) throw new HelperException("capture_region_invalid", $"screen.capture bounds are empty: {bounds}");
        var (bytes, quality) = CaptureScreenPng(bounds);
        if (!quality.NonBlank)
        {
            throw new HelperException("screenshot_blank", $"Screen region screenshot is blank: varied={quality.VariedRatio}, bright={quality.BrightRatio}");
        }
        return new
        {
            width = bounds.Width,
            height = bounds.Height,
            bounds,
            mimeType = "image/png",
            coordinateSpace = "screenPixel",
            nonBlank = quality.NonBlank,
            captureMethod = "copyFromScreen",
            quality,
            sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            dataBase64 = Convert.ToBase64String(bytes),
            pngBase64 = Convert.ToBase64String(bytes),
        };
    }

    private static (byte[] Bytes, BitmapQuality Quality) CaptureScreenPng(Bounds bounds)
    {
        using var bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, new Size(bounds.Width, bounds.Height), CopyPixelOperation.SourceCopy);
        }
        var quality = AnalyzeBitmap(bitmap);
        using var stream = new MemoryStream();
        bitmap.Save(stream, ImageFormat.Png);
        return (stream.ToArray(), quality);
    }

    private static object ImageCropHash(JsonElement parameters)
    {
        var dataBase64 = ReadString(parameters, "dataBase64");
        if (string.IsNullOrWhiteSpace(dataBase64)) throw new HelperException("image_crop_missing", "image.cropHash requires dataBase64");
        var bbox = ReadBounds(parameters, "bbox") ?? throw new HelperException("image_crop_missing", "image.cropHash requires bbox");
        var includeDataBase64 = ReadBool(parameters, "includeDataBase64") ?? false;
        using var sourceStream = new MemoryStream(Convert.FromBase64String(dataBase64));
        using var sourceBitmap = new Bitmap(sourceStream);
        if (bbox.X < 0 || bbox.Y < 0 || bbox.Width <= 0 || bbox.Height <= 0 || bbox.X + bbox.Width > sourceBitmap.Width || bbox.Y + bbox.Height > sourceBitmap.Height)
        {
            throw new HelperException("image_crop_out_of_bounds", $"image.cropHash bbox is outside image bounds: bbox={bbox}, image={sourceBitmap.Width}x{sourceBitmap.Height}");
        }
        using var cropped = sourceBitmap.Clone(new Rectangle(bbox.X, bbox.Y, bbox.Width, bbox.Height), PixelFormat.Format32bppArgb);
        using var stream = new MemoryStream();
        cropped.Save(stream, ImageFormat.Png);
        var bytes = stream.ToArray();
        return new
        {
            hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            mimeType = "image/png",
            width = bbox.Width,
            height = bbox.Height,
            bbox,
            dataBase64 = includeDataBase64 ? Convert.ToBase64String(bytes) : null,
        };
    }

    private static Bounds DefaultMenuSearchBounds(JsonElement parameters)
    {
        if (!GetCursorPos(out var cursor))
        {
            throw new HelperException("cursor_position_unavailable", "Cannot read cursor position for menu.pickItem");
        }
        var width = (int)(ReadInt64(parameters, "searchWidth") ?? 520);
        var height = (int)(ReadInt64(parameters, "searchHeight") ?? 720);
        if (width <= 0 || height <= 0) throw new HelperException("capture_region_invalid", "menu.pickItem searchWidth/searchHeight must be positive");
        return new Bounds(cursor.X - Math.Min(160, width / 2), cursor.Y - height / 2, width, height);
    }

    private static MenuMatch? SelectMenuMatch(OcrBlock[] blocks, IEnumerable<MenuLabel> labels, HashSet<string> disallowed)
    {
        foreach (var block in blocks)
        {
            if (block.Bbox is null) continue;
            var normalizedText = NormalizeMenuText(block.Text);
            if (normalizedText.Length == 0 || disallowed.Any(label => IsMenuTextMatch(normalizedText, label))) continue;
            foreach (var label in labels)
            {
                if (!IsMenuTextMatch(normalizedText, label.Normalized)) continue;
                return new MenuMatch(label.Raw, block.Text, block.Bbox);
            }
        }
        return null;
    }

    private static bool IsMenuTextMatch(string text, string label)
        => text == label || text.Contains(label, StringComparison.Ordinal) || label.Contains(text, StringComparison.Ordinal);

    private static string NormalizeMenuText(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        var builder = new StringBuilder();
        foreach (var rune in value.Normalize(NormalizationForm.FormKC))
        {
            if (char.IsWhiteSpace(rune)) continue;
            if (char.IsPunctuation(rune) || char.IsSymbol(rune)) continue;
            builder.Append(char.ToLowerInvariant(rune));
        }
        return builder.ToString();
    }

    private static object MenuPickItem(JsonElement parameters)
    {
        var labels = ReadStringArray(parameters, "labels");
        if (labels.Length == 0) throw new HelperException("helper_invalid_response", "menu.pickItem requires labels");
        var normalizedLabels = labels
            .Select(static label => new MenuLabel(label, NormalizeMenuText(label)))
            .Where(static label => label.Normalized.Length > 0)
            .ToArray();
        if (normalizedLabels.Length == 0) throw new HelperException("helper_invalid_response", "menu.pickItem labels are empty after normalization");

        var disallowed = ReadStringArray(parameters, "disallowLabels")
            .Select(NormalizeMenuText)
            .Where(static label => label.Length > 0)
            .ToHashSet(StringComparer.Ordinal);
        var dryRun = ReadBool(parameters, "dryRun") ?? false;
        var attempts = (int)(ReadInt64(parameters, "attempts") ?? 3);
        var menuDelayMs = (int)(ReadInt64(parameters, "menuDelayMs") ?? 120);
        if (attempts <= 0) throw new HelperException("helper_invalid_response", "menu.pickItem attempts must be positive");
        if (menuDelayMs < 0) throw new HelperException("helper_invalid_response", "menu.pickItem menuDelayMs must be non-negative");
        var bounds = ReadBounds(parameters, "bounds") ?? ReadBounds(parameters, "searchBounds") ?? DefaultMenuSearchBounds(parameters);

        var tempDir = Path.Combine(Path.GetTempPath(), "shennian-wechat-channel-ocr");
        Directory.CreateDirectory(tempDir);
        var tempImagePath = Path.Combine(tempDir, $"{Guid.NewGuid():N}-menu.png");
        try
        {
            MenuMatch? match = null;
            OcrRunResult? lastRun = null;
            byte[]? lastBytes = null;
            BitmapQuality? lastQuality = null;
            if (menuDelayMs > 0) JitteredSleep(menuDelayMs, 0.20);
            for (var attempt = 0; attempt < attempts; attempt++)
            {
                var (bytes, quality) = CaptureScreenPng(bounds);
                lastBytes = bytes;
                lastQuality = quality;
                if (!quality.NonBlank)
                {
                    if (attempt + 1 < attempts)
                    {
                        JitteredSleep(menuDelayMs, 0.20);
                        continue;
                    }
                    throw new HelperException("screenshot_blank", $"Menu screenshot is blank: varied={quality.VariedRatio}, bright={quality.BrightRatio}");
                }

                File.WriteAllBytes(tempImagePath, bytes);
                lastRun = RunOcr(tempImagePath, parameters);
                match = SelectMenuMatch(lastRun.Blocks, normalizedLabels, disallowed);
                if (match is not null) break;
                if (attempt + 1 < attempts) JitteredSleep(menuDelayMs, 0.20);
            }
            if (match is null)
            {
                throw new HelperException("menu_item_not_found", $"Menu item not found: {string.Join(", ", labels)}");
            }
            var screenPoint = new Point(bounds.X + match.Bbox.X + match.Bbox.Width / 2, bounds.Y + match.Bbox.Y + match.Bbox.Height / 2);
            if (!dryRun)
            {
                ClickScreenPoint(screenPoint, rightButton: false);
            }
            return new
            {
                label = match.Label,
                text = match.Text,
                clicked = !dryRun,
                dryRun,
                attempts,
                point = new { x = screenPoint.X, y = screenPoint.Y, coordinateSpace = "screen" },
                bbox = match.Bbox,
                bounds,
                capture = new
                {
                    width = bounds.Width,
                    height = bounds.Height,
                    sha256 = Convert.ToHexString(SHA256.HashData(lastBytes ?? Array.Empty<byte>())).ToLowerInvariant(),
                    quality = lastQuality,
                },
                ocr = new
                {
                    provider = lastRun?.Provider,
                    durationMs = lastRun?.DurationMs,
                    blockCount = lastRun?.Blocks.Length ?? 0,
                },
            };
        }
        finally
        {
            File.Delete(tempImagePath);
        }
    }

    private static string? ReadString(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string[] ReadStringArray(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Array
            ? value.EnumerateArray()
                .Where(static item => item.ValueKind == JsonValueKind.String)
                .Select(static item => item.GetString() ?? "")
                .Where(static item => !string.IsNullOrWhiteSpace(item))
                .ToArray()
            : [];

    private static bool? ReadBool(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var value)
            && (value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.False)
            ? value.GetBoolean()
            : null;

    private static long? ReadInt64(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt64(out var number)
            ? number
            : null;

    private static float? ReadSingle(JsonElement element, string name)
        => element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetSingle(out var number)
            ? number
            : null;

    private static Bounds? ReadCrop(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        var cropBounds = ReadBounds(element, "crop");
        if (cropBounds is not null) return cropBounds;
        var x = ReadInt64(element, "cropX");
        var y = ReadInt64(element, "cropY");
        var width = ReadInt64(element, "cropWidth");
        var height = ReadInt64(element, "cropHeight");
        if (x is null && y is null && width is null && height is null) return null;
        if (x is null || y is null || width is null || height is null) throw new HelperException("ocr_crop_invalid", "OCR crop requires cropX, cropY, cropWidth and cropHeight");
        return new Bounds((int)x.Value, (int)y.Value, (int)width.Value, (int)height.Value);
    }

    private static Bounds? ReadBounds(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var bounds) || bounds.ValueKind != JsonValueKind.Object) return null;
        return new Bounds(
            RequireInt(bounds, "x", name),
            RequireInt(bounds, "y", name),
            RequireInt(bounds, "width", name),
            RequireInt(bounds, "height", name));
    }

    private static Point ReadPoint(JsonElement element)
    {
        var point = ReadPointElement(element);
        var x = ReadCoordinate(point, "x");
        var y = ReadCoordinate(point, "y");
        if (x is null || y is null) throw new HelperException("mouse_point_missing", "Mouse command requires x and y");
        return new Point(x.Value, y.Value);
    }

    private static JsonElement ReadPointElement(JsonElement element)
    {
        return element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty("point", out var point)
            && point.ValueKind == JsonValueKind.Object
            ? point
            : element;
    }

    private static string DescribeJsonKeys(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object) return $"params={element.ValueKind}";
        var keys = element.EnumerateObject().Select(static property => property.Name).Take(12).ToArray();
        return keys.Length == 0 ? "paramsKeys=[]" : $"paramsKeys=[{string.Join(",", keys)}]";
    }

    private static Point? ReadOptionalPoint(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var point) || point.ValueKind != JsonValueKind.Object) return null;
        var x = ReadCoordinate(point, "x");
        var y = ReadCoordinate(point, "y");
        return x is null || y is null ? null : new Point(x.Value, y.Value);
    }

    private static int? ReadCoordinate(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Number) return null;
        if (value.TryGetInt32(out var integer)) return integer;
        return value.TryGetDouble(out var number) && double.IsFinite(number) ? (int)Math.Round(number) : null;
    }

    private static long? ReadWindowId(JsonElement element)
    {
        var raw = ReadString(element, "windowId");
        return long.TryParse(raw, out var value) ? value : null;
    }

    private static Point WindowPointToScreenPoint(Point point)
    {
        var window = SelectBestWindow() ?? throw new HelperException("wechat_window_not_found", "No visible capturable WeChat window found");
        return new Point(window.Bounds.X + point.X, window.Bounds.Y + point.Y);
    }

    private static int RequireInt(JsonElement element, string name, string parentName)
    {
        var value = ReadInt64(element, name);
        if (value is null) throw new HelperException("ocr_crop_invalid", $"OCR {parentName} requires integer {name}");
        return (int)value.Value;
    }

    private static string? GetString(Dictionary<string, object?>? value, string name)
    {
        if (value is null || !value.TryGetValue(name, out var raw)) return null;
        if (raw is JsonElement element && element.ValueKind == JsonValueKind.String) return element.GetString();
        return raw?.ToString();
    }

    private static double ElapsedMs(DateTimeOffset started)
        => Math.Round((DateTimeOffset.UtcNow - started).TotalMilliseconds, 3);

    private static void WriteJson(object value)
    {
        Console.WriteLine(JsonSerializer.Serialize(value, JsonOptions));
        Console.Out.Flush();
    }

    private static void TryEnableDpiAwareness()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
        }
        catch
        {
            // Best-effort; fall back below.
        }

        try
        {
            _ = SetProcessDPIAware();
        }
        catch
        {
            // DPI awareness failure is reported through coordinate smoke.
        }
    }

}
