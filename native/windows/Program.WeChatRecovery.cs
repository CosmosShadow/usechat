// @arch docs/features/wechat-rpa/windows-runtime/operations-safety.md
// @test src/__tests__/wechat-channel-windows-helper-source.test.ts

using System.Diagnostics;
using System.Text.Json;
using System.Threading;

namespace UseChat.WeChatChannel.Helper.Win;

internal static partial class Program
{
    private static object RecoverWeChat(JsonElement parameters)
    {
        var allowRestart = ReadBool(parameters, "allowRestart") ?? false;
        var onlyIfUnresponsive = ReadBool(parameters, "onlyIfUnresponsive") ?? true;
        var waitForExitMs = Math.Max(500, Math.Min(8000, (int)(ReadInt64(parameters, "waitForExitMs") ?? 2500)));
        var waitAfterStartMs = Math.Max(0, Math.Min(8000, (int)(ReadInt64(parameters, "waitAfterStartMs") ?? 1500)));
        var windowsBefore = ListWeChatWindows();
        var bestWindow = windowsBefore.FirstOrDefault(IsRestoreCandidate);
        var wasUnresponsive = bestWindow is not null && IsHungAppWindow(bestWindow.RawHandle);

        if (onlyIfUnresponsive && !wasUnresponsive)
        {
            return new
            {
                ok = true,
                skipped = true,
                reasonCode = bestWindow is null ? "wechat_window_not_found" : "wechat_window_responsive",
                allowRestart,
                onlyIfUnresponsive,
                wasUnresponsive,
                windowsBefore,
                foregroundAfter = GetForegroundWindowSnapshot(),
            };
        }

        if (!allowRestart)
        {
            throw new HelperException("wechat_window_unresponsive", "WeChat main window is not responding; restart was not authorized");
        }

        var overlayCleanup = CleanupSafeOverlays(JsonSerializer.SerializeToElement(new
        {
            includeGeneratedMediaPreviews = true,
            includeToolingTerminals = true,
            waitMs = 250,
        }));
        var processes = Process.GetProcesses()
            .Where(static process => process.ProcessName is "Weixin" or "WeChat" or "WeChatAppEx")
            .OrderBy(static process => process.ProcessName)
            .ThenBy(static process => process.Id)
            .ToArray();
        var launchPath = processes
            .Select(ReadProcessMainModulePath)
            .FirstOrDefault(static path => !string.IsNullOrWhiteSpace(path));
        var snapshots = new List<WeChatRecoveryProcessSnapshot>();

        foreach (var process in processes)
        {
            var closeRequested = false;
            var exitedAfterClose = false;
            var killed = false;
            var modulePath = ReadProcessMainModulePath(process);
            var isMainWeChatProcess = process.ProcessName is "Weixin" or "WeChat";
            try
            {
                if (!process.HasExited)
                {
                    closeRequested = process.CloseMainWindow();
                    if (closeRequested)
                    {
                        exitedAfterClose = process.WaitForExit(waitForExitMs);
                    }
                }
                // WeChatAppEx hosts mini-programs and the video-channel sandbox. Killing
                // it directly can corrupt state and crash WeChat; let it exit naturally
                // when its parent Weixin/WeChat closes. We only force-kill the main shell.
                if (!process.HasExited && isMainWeChatProcess)
                {
                    process.Kill();
                    killed = true;
                    process.WaitForExit(waitForExitMs);
                }
            }
            catch
            {
                // Recovery is best-effort, but the caller receives per-process evidence below.
            }
            snapshots.Add(new WeChatRecoveryProcessSnapshot(
                process.Id,
                process.ProcessName,
                modulePath,
                closeRequested,
                exitedAfterClose,
                killed));
            process.Dispose();
        }

        var started = false;
        string? startError = null;
        if (!string.IsNullOrWhiteSpace(launchPath))
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = launchPath,
                    UseShellExecute = true,
                    WorkingDirectory = Path.GetDirectoryName(launchPath) ?? Environment.CurrentDirectory,
                });
                started = true;
                if (waitAfterStartMs > 0) Thread.Sleep(waitAfterStartMs);
            }
            catch (Exception error)
            {
                startError = error.Message;
            }
        }

        var windowsAfter = ListWeChatWindows();
        return new
        {
            ok = started && startError is null,
            allowRestart,
            onlyIfUnresponsive,
            wasUnresponsive,
            launchPathFound = !string.IsNullOrWhiteSpace(launchPath),
            started,
            startError,
            restartAttempted = true,
            processCount = snapshots.Count,
            processes = snapshots,
            overlayCleanup,
            windowsBefore,
            windowsAfter,
            loginConfirmationMayBeRequired = true,
            reasonCode = started ? "wechat_restarted_pending_login_confirmation" : "wechat_recovery_failed",
            foregroundAfter = GetForegroundWindowSnapshot(),
        };
    }

    private static string? ReadProcessMainModulePath(Process process)
    {
        try
        {
            return process.MainModule?.FileName;
        }
        catch
        {
            return null;
        }
    }
}
