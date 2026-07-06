// @arch docs/features/wechat-rpa/windows-runtime.md
// @test src/__tests__/wechat-channel-windows-helper-source.test.ts

using System.Diagnostics;
using System.Text.Json.Serialization;

namespace Shennian.WeChatChannel.Helper.Win;

internal static partial class Program
{
    private sealed class HelperException(string code, string message) : Exception(message)
    {
        public string Code { get; } = code;
    }

    private sealed record ProcessSnapshot(int ProcessId, string ProcessName, int SessionId, string? MainModulePath)
    {
        public static ProcessSnapshot? TryFrom(Process process)
        {
            try
            {
                return new ProcessSnapshot(process.Id, process.ProcessName, process.SessionId, ReadProcessMainModulePath(process));
            }
            catch
            {
                return null;
            }
        }
    }

    private sealed record WindowSnapshot([property: JsonIgnore] IntPtr RawHandle, int ProcessId, string ProcessName, string Title, string ClassName, bool Visible, bool Minimized, Bounds Bounds, int RootProcessId, string RootProcessName, int ZOrder)
    {
        public long Handle => RawHandle.ToInt64();
        public string WindowId => RawHandle.ToInt64().ToString();
        public string AppName => "WeChat";
        public bool CaptureCandidate => IsCaptureCandidate(this);
        public bool RestoreCandidate => IsRestoreCandidate(this);
    }

    private sealed record RawWindowSnapshot(long Handle, int ProcessId, string ProcessName, string Title, string ClassName, bool Visible, Bounds Bounds, int ZOrder);

    private sealed record SafeOverlayWindowSnapshot(long Handle, int ProcessId, string ProcessName, string Title, string ClassName, Bounds Bounds, string Reason, bool ClosePosted);

    private sealed record WeChatRecoveryProcessSnapshot(int ProcessId, string ProcessName, string? MainModulePath, bool CloseMainWindowRequested, bool ExitedAfterClose, bool Killed);

    private sealed record WeChatEntryRecoveryResult(bool Attempted, bool Clicked, bool LoginRequired, string Strategy, string Reason, Bounds? Bbox, object? Point, string? DebugImagePath = null)
    {
        public static WeChatEntryRecoveryResult NotAttempted => new(false, false, false, "none", "not_attempted", null, null);
    }

    private sealed record WeChatLaunchRecoveryResult(bool Started, string Reason, string? LaunchPath, string? Error);

    private sealed record EntryButtonCandidate(string Strategy, string Text, Bounds Bbox, double Score);

    private sealed record ForegroundWindowSnapshot(long Handle, uint ProcessId, string ProcessName, string Title, string ClassName);

    private sealed record BitmapQuality(int Samples, double VariedRatio, double BrightRatio, bool NonBlank);

    private sealed record OcrWord(string Text, double Confidence, object[] Polygon, Bounds? Bbox, string CoordinateSpace);

    private sealed record OcrBlock(string Text, double? Confidence, double Score, object[] Polygon, Bounds? Bbox, string CoordinateSpace, OcrWord[] Words);

    private sealed record OcrRunResult(string Provider, string Engine, string ModelSet, string Language, double DurationMs, double DetectTimeMs, double DbNetTimeMs, string Text, OcrBlock[] Blocks);

    private sealed record OcrModelFiles(string DetPath, string ClsPath, string RecPath, string KeysPath);

    private sealed record InputTextVerification(bool Ok, Bounds Crop, string ExpectedText, string NormalizedText, int BlockCount);

    private sealed record MenuLabel(string Raw, string Normalized);

    private sealed record MenuMatch(string Label, string Text, Bounds Bbox);

    private sealed record AutomationLease(
        string LeaseId,
        string Owner,
        string Purpose,
        DateTimeOffset AcquiredAt,
        DateTimeOffset ExpiresAt,
        long BaselineLastInputTick,
        ForegroundWindowSnapshot? ExpectedForeground,
        DateTimeOffset? InterruptedAt = null,
        string? InterruptReason = null);

    private sealed record Bounds(int X, int Y, int Width, int Height)
    {
        public static Bounds FromRect(RECT rect)
            => new(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }
}
