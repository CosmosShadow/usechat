// @arch docs/features/wechat-rpa/windows-runtime.md
// @test src/__tests__/wechat-channel-windows-helper-source.test.ts

using System.Text.Json;
using System.Threading;

namespace UseChat.WeChatChannel.Helper.Win;

internal static partial class Program
{
    private static object CleanupSafeOverlays(JsonElement parameters)
    {
        var dryRun = ReadBool(parameters, "dryRun") ?? false;
        var includeGeneratedMediaPreviews = ReadBool(parameters, "includeGeneratedMediaPreviews") ?? true;
        var includeToolingTerminals = ReadBool(parameters, "includeToolingTerminals") ?? false;
        var waitMs = Math.Max(0, Math.Min(1000, (int)(ReadInt64(parameters, "waitMs") ?? 180)));
        var candidates = new List<SafeOverlayWindowSnapshot>();

        EnumWindows((handle, _) =>
        {
            if (!IsWindowVisible(handle) || IsIconic(handle)) return true;
            if (!GetWindowRect(handle, out var rect)) return true;
            GetWindowThreadProcessId(handle, out var processId);
            var processName = ReadProcessName((int)processId);
            var title = ReadWindowText(handle);
            var className = ReadClassName(handle);
            if (IsWeChatOwnedWindow(processName)) return true;

            var reason = SafeOverlayCloseReason(processName, title, className, (int)processId, includeGeneratedMediaPreviews, includeToolingTerminals);
            if (reason is null) return true;

            var posted = false;
            if (!dryRun)
            {
                posted = IsWindow(handle) && PostMessage(handle, WmClose, IntPtr.Zero, IntPtr.Zero);
            }
            candidates.Add(new SafeOverlayWindowSnapshot(
                handle.ToInt64(),
                (int)processId,
                processName,
                title,
                className,
                Bounds.FromRect(rect),
                reason,
                posted));
            return true;
        }, IntPtr.Zero);

        if (!dryRun && candidates.Count > 0 && waitMs > 0)
        {
            Thread.Sleep(waitMs);
        }

        return new
        {
            ok = true,
            dryRun,
            includeGeneratedMediaPreviews,
            includeToolingTerminals,
            candidateCount = candidates.Count,
            closePostedCount = candidates.Count(static candidate => candidate.ClosePosted),
            candidates,
            foregroundAfter = GetForegroundWindowSnapshot(),
        };
    }

    private static string? SafeOverlayCloseReason(
        string processName,
        string title,
        string className,
        int processId,
        bool includeGeneratedMediaPreviews,
        bool includeToolingTerminals)
    {
        if (includeGeneratedMediaPreviews
            && IsKnownViewerProcess(processName, className)
            && IsGeneratedMediaPreviewTitle(title))
        {
            return "generated-media-preview";
        }

        if (includeToolingTerminals && IsKnownToolingTerminal(processName, title, processId))
        {
            return "shennian-tooling-terminal";
        }

        return null;
    }

    private static bool IsWeChatOwnedWindow(string processName)
        => IsWeChatProcessName(processName);

    private static bool IsWeChatProcessName(string processName)
        => processName is "Weixin" or "WeChat" or "WeChatAppEx";

    private static bool IsKnownViewerProcess(string processName, string className)
        => processName is "Photos" or "Microsoft.Photos" or "PhotosApp" or "ApplicationFrameHost" or "Video.UI" or "MediaPlayer" or "Microsoft.Media.Player"
            || className is "WinUIDesktopWin32WindowClass" or "ApplicationFrameWindow";

    private static bool IsGeneratedMediaPreviewTitle(string title)
    {
        var normalized = title.Trim().ToLowerInvariant();
        if (normalized.Length == 0) return false;
        return normalized.Contains("wechat-action-smoke-", StringComparison.Ordinal)
            || normalized.Contains("codex-product-action", StringComparison.Ordinal)
            || normalized.Contains("shennian-wechat", StringComparison.Ordinal)
            || normalized.Contains("download-visible", StringComparison.Ordinal)
            || normalized.Contains("video-preview", StringComparison.Ordinal)
            || normalized.StartsWith("preview-", StringComparison.Ordinal);
    }

    private static bool IsKnownToolingTerminal(string processName, string title, int processId)
    {
        var normalizedTitle = title.Trim().ToLowerInvariant();
        var terminalProcess = processName is "WindowsTerminal" or "OpenConsole" or "powershell" or "pwsh" or "cmd";
        if (!terminalProcess) return false;
        if (normalizedTitle.Contains("shennian", StringComparison.Ordinal)
            || normalizedTitle.Contains("wechat-rpa", StringComparison.Ordinal)
            || normalizedTitle.Contains("wechat-channel", StringComparison.Ordinal)
            || normalizedTitle.Contains("powershell.exe", StringComparison.Ordinal)
            || normalizedTitle.Contains("cmd.exe", StringComparison.Ordinal)
            || normalizedTitle.StartsWith(@"c:\windows\system32\windowspowershell", StringComparison.Ordinal)
            || normalizedTitle.StartsWith(@"c:\windows\system32\cmd", StringComparison.Ordinal))
        {
            return true;
        }

        var commandLine = ReadProcessCommandLine(processId).ToLowerInvariant();
        return commandLine.Contains("shennian", StringComparison.Ordinal)
            || commandLine.Contains("wechat-rpa", StringComparison.Ordinal)
            || commandLine.Contains("wechat-channel", StringComparison.Ordinal);
    }

    private static string ReadProcessCommandLine(int processId)
    {
        try
        {
            using var searcher = new System.Management.ManagementObjectSearcher(
                $"SELECT CommandLine FROM Win32_Process WHERE ProcessId = {processId}");
            foreach (var item in searcher.Get())
            {
                return Convert.ToString(item["CommandLine"]) ?? "";
            }
        }
        catch
        {
            return "";
        }
        return "";
    }
}
