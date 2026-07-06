// @arch docs/features/wechat-rpa/windows-runtime.md
// @test src/__tests__/wechat-channel-windows-helper-source.test.ts

using System.Drawing;
using System.Text.Json;
using System.Threading;
using System.Windows.Forms;

namespace Shennian.WeChatChannel.Helper.Win;

internal static partial class Program
{
    private static object WeChatHealthProbe(JsonElement parameters)
    {
        var processes = FindWeChatProcesses();
        var windows = ListWeChatWindows();
        var restorable = windows.Where(IsRestoreCandidate).ToArray();
        var capturable = windows.Where(IsCaptureCandidate).ToArray();
        var hiddenRestorable = windows.Where(IsHiddenRestorableWindow).ToArray();
        var foreground = GetForegroundWindowSnapshot();
        // "Stuck shell" is the symptom we have observed in production: the
        // Weixin process tree keeps running (tray icon visible, messages keep
        // arriving in popped-out chat windows) but the main UI window is
        // missing. Detect it by combining process existence with the absence
        // of any usable top-level window.
        var stuckShell = processes.Length > 0
            && restorable.Length == 0
            && capturable.Length == 0
            && hiddenRestorable.Length == 0;
        var loginRequired = processes.Length > 0 && IsAnyLoginScreen(windows);
        // Count distinct visible primary-shell main windows. >=2 is the "two
        // main UI windows" duplicate symptom (old window + freshly-popped
        // "logged-in welcome window") the CLI uses as a cheap local gate before
        // spending a cloud window classification pass.
        var mainWindowCount = capturable.Count(IsPrimaryWeChatShellWindow);
        var responsive = restorable.FirstOrDefault() is { } window
            ? !IsHungAppWindow(window.RawHandle)
            : (bool?)null;
        var reasonCode = stuckShell
            ? "wechat_main_window_lost"
            : loginRequired
                ? "wechat_login_required"
                : processes.Length == 0
                    ? "wechat_not_running"
                    : responsive == false
                        ? "wechat_window_unresponsive"
                        : restorable.Length == 0 && hiddenRestorable.Length > 0
                            ? "wechat_window_hidden"
                            : null;
        return new
        {
            ok = reasonCode is null,
            reasonCode,
            stuckShell,
            loginRequired,
            wechatRunning = processes.Length > 0,
            mainWindowAvailable = restorable.Length > 0,
            mainWindowCount,
            captureCandidateCount = capturable.Length,
            restoreCandidateCount = restorable.Length,
            hiddenRestoreCandidateCount = hiddenRestorable.Length,
            wechatMainWindowResponsive = responsive,
            processCount = processes.Length,
            processes,
            windows,
            foregroundApp = foreground,
        };
    }

    private static bool IsAnyLoginScreen(WindowSnapshot[] windows)
    {
        foreach (var window in windows)
        {
            if (!window.Visible) continue;
            if (window.Title.Contains("登录", StringComparison.Ordinal)) return true;
            if (window.Title.Contains("扫码", StringComparison.Ordinal)) return true;
        }
        return false;
    }

    private static object WeChatSearchConversation(JsonElement parameters)
    {
        var text = (ReadString(parameters, "conversationName") ?? ReadString(parameters, "text") ?? "").Trim();
        if (text.Length == 0) throw new HelperException("helper_invalid_response", "wechat.searchConversation requires conversationName or text");
        var window = SelectRequestedOrRestorableWindow(parameters)
            ?? throw new HelperException("wechat_window_not_found", "No restorable WeChat window found");
        EnsureForeground(window);
        var activateWaitMs = Math.Max(0, Math.Min(3000, (int)(ReadInt64(parameters, "activateWaitMs") ?? 220)));
        JitteredSleep(activateWaitMs, 0.15);
        // The search box is the first interactive surface WeChat's anti-RPA
        // watches: bringing the window forward and immediately clicking is the
        // scripted cadence that gets the shell torn down mid-search. Wait a
        // human-reaction beat before the first click, same as the composer.
        HumanReactionSleep(activateWaitMs);
        var explicitPoint = ReadOptionalPoint(parameters, "searchPoint");
        if (explicitPoint is null) throw new HelperException("wechat_search_input_point_required", "wechat.searchConversation requires a vision-detected searchPoint");
        var point = explicitPoint.Value;
        // Click the search field to focus it. Two slow clicks instead of a
        // Ctrl+A → Backspace combo: Ctrl+A is a select-all fingerprint that
        // WeChat actively watches for, and triggering it makes the field lose
        // focus.
        ClickScreenPoint(point, rightButton: false);
        JitteredSleep(180, 0.4);
        ClickScreenPoint(point, rightButton: false);
        JitteredSleep(180, 0.4);
        // Move caret to end-of-line, then erase any residual draft with a
        // handful of Backspace keystrokes. Caps at 32 keystrokes which is
        // plenty for the search field. Jitter between keystrokes: a zero-delay
        // 32-key burst is a machine-gun fingerprint no human produces.
        PressShortcut(VirtualKeyEnd, []);
        JitteredSleep(60);
        for (var i = 0; i < 32; i += 1)
        {
            PressShortcut(VirtualKeyBack, []);
            JitteredSleep(14, 0.6);
        }
        // Read the field for a beat before pasting, the way a person checks the
        // box is empty before typing the name.
        HumanReactionSleep(0);
        RunClipboardOperation("wechat.searchConversation.clipboard", () =>
        {
            Clipboard.SetText(text, TextDataFormat.UnicodeText);
            return true;
        });
        PressShortcut((ushort)'V', [VirtualKeyControl]);
        var waitMs = Math.Max(0, Math.Min(3000, (int)(ReadInt64(parameters, "waitMs") ?? 700)));
        JitteredSleep(waitMs, 0.15);
        return new
        {
            searched = true,
            conversationName = text,
            strategy = "explicit-search-point",
            searchField = new { x = point.X - 60, y = point.Y - 18, width = 220, height = 42, coordinateSpace = "screen" },
        };
    }

    private static object WeChatFocusMessageInput(JsonElement parameters)
    {
        var window = SelectRequestedOrRestorableWindow(parameters)
            ?? throw new HelperException("wechat_window_not_found", "No restorable WeChat window found");
        EnsureForeground(window);
        var waitMs = Math.Max(0, Math.Min(3000, (int)(ReadInt64(parameters, "waitMs") ?? 220)));
        JitteredSleep(waitMs, 0.15);
        // A real user doesn't click the composer the instant the window comes
        // forward. Wait a human-reaction interval before the first click so the
        // activation->input cadence doesn't read as scripted.
        HumanReactionSleep(waitMs);
        var explicitPoint = ReadOptionalPoint(parameters, "inputPoint");
        if (explicitPoint is null) throw new HelperException("wechat_message_input_point_required", "wechat.focusMessageInput requires a vision-detected inputPoint");
        var point = explicitPoint.Value;
        ClickScreenPoint(point, rightButton: false);
        JitteredSleep(140, 0.4);
        ClickScreenPoint(point, rightButton: false);
        JitteredSleep(160, 0.4);
        return new
        {
            focused = true,
            strategy = "explicit-input-point",
            point = new { x = point.X, y = point.Y, coordinateSpace = "screen" },
            window = new
            {
                windowId = window.WindowId,
                handle = window.Handle,
                title = window.Title,
                bounds = window.Bounds,
            },
            foregroundAfter = GetForegroundWindowSnapshot(),
        };
    }
    private static object WeChatPasteAndSubmit(JsonElement parameters)
    {
        var text = ReadString(parameters, "text");
        if (text is null) throw new HelperException("helper_invalid_response", "wechat.pasteAndSubmit requires text");
        var focus = WeChatFocusMessageInput(parameters);
        var window = SelectRequestedOrRestorableWindow(parameters)
            ?? throw new HelperException("wechat_window_not_found", "No restorable WeChat window found");
        var inputPoint = ReadOptionalPoint(parameters, "inputPoint")
            ?? throw new HelperException("wechat_message_input_point_required", "wechat.pasteAndSubmit requires a vision-detected inputPoint");
        RunClipboardOperation("wechat.pasteAndSubmit.clipboard", () =>
        {
            Clipboard.SetText(text, TextDataFormat.UnicodeText);
            return true;
        });
        // Pause before paste: focus just landed on the composer, and pasting in
        // the same beat is a scripted tell.
        HumanReactionSleep(0);
        PressShortcut((ushort)'V', [VirtualKeyControl]);
        var pasteWaitMs = Math.Max(0, Math.Min(5000, (int)(ReadInt64(parameters, "pasteWaitMs") ?? 900)));
        JitteredSleep(pasteWaitMs, 0.15);
        var verification = VerifyInputContainsText(window, inputPoint, text);
        if (!verification.Ok && WeChatPasteVerifyHardEnabled())
        {
            throw new HelperException("wechat_paste_not_applied", $"Text was not visible in the WeChat input area before submit: expected={NormalizeInputVerificationText(text)}, observed={verification.NormalizedText}");
        }
        // Pause before Enter: a person reads what they pasted before hitting
        // send. submitWaitMs below is the *post*-submit settle, so the pre-Enter
        // gap has to be added explicitly here.
        HumanReactionSleep(0);
        PressShortcut(VirtualKeyReturn, []);
        var submitWaitMs = Math.Max(0, Math.Min(3000, (int)(ReadInt64(parameters, "submitWaitMs") ?? 160)));
        JitteredSleep(submitWaitMs, 0.15);
        return new
        {
            submitted = true,
            strategy = "atomic-clipboard-paste",
            focus,
            inputVerification = verification,
            changeCount = GetClipboardSequenceNumber(),
            foregroundAfter = GetForegroundWindowSnapshot(),
        };
    }

    private static InputTextVerification VerifyInputContainsText(WindowSnapshot window, Point inputPoint, string text)
    {
        var crop = InputAreaCrop(window, inputPoint);
        var tempDir = Path.Combine(Path.GetTempPath(), "shennian-wechat-channel-input-verify");
        Directory.CreateDirectory(tempDir);
        var tempImagePath = Path.Combine(tempDir, $"{Guid.NewGuid():N}.png");
        try
        {
            using (var bitmap = CaptureScreenBitmap(crop))
            {
                bitmap.Save(tempImagePath, System.Drawing.Imaging.ImageFormat.Png);
            }
            using var parameters = JsonDocument.Parse("{}");
            var run = RunOcr(tempImagePath, parameters.RootElement);
            var observed = NormalizeInputVerificationText(run.Text);
            var expected = NormalizeInputVerificationText(text);
            return new InputTextVerification(
                expected.Length > 0 && observed.Contains(expected, StringComparison.Ordinal),
                crop,
                expected,
                observed,
                run.Blocks.Length);
        }
        finally
        {
            try { File.Delete(tempImagePath); } catch { }
        }
    }

    private static Bounds InputAreaCrop(WindowSnapshot window, Point inputPoint)
    {
        var localY = Math.Max(0, Math.Min(window.Bounds.Height - 1, inputPoint.Y - window.Bounds.Y));
        var left = Math.Max(0, (int)Math.Round(window.Bounds.Width * 0.30));
        // The vision-detected inputPoint sits inside the WeChat composer text area.
        // Keep the crop tight around that line so OCR only reads what the user is
        // typing — including the surrounding chat bubbles trips false positives
        // when a recent send echo matches the new marker.
        var top = Math.Max(0, localY - 24);
        var rightPadding = 18;
        var bottomPadding = 18;
        var width = Math.Max(80, window.Bounds.Width - left - rightPadding);
        var height = Math.Min(64, Math.Max(40, window.Bounds.Height - top - bottomPadding));
        return new Bounds(window.Bounds.X + left, window.Bounds.Y + top, width, height);
    }

    private static string NormalizeInputVerificationText(string text)
        => new(text
            .Where(static character => !char.IsWhiteSpace(character))
            .Select(static character => char.ToLowerInvariant(character))
            .ToArray());

    private static bool WeChatPasteVerifyHardEnabled()
        => string.Equals(Environment.GetEnvironmentVariable("SHENNIAN_WECHAT_PASTE_VERIFY_HARD"), "1", StringComparison.Ordinal);
}
