// @arch docs/features/wechat-rpa/windows-runtime.md
// @test src/__tests__/wechat-channel-windows-helper-source.test.ts

using System.Text.Json;

namespace Shennian.WeChatChannel.Helper.Win;

internal static partial class Program
{
    private static readonly object AutomationLeaseLock = new();
    private static AutomationLease? CurrentAutomationLease;

    private static object AutomationLeaseAcquire(JsonElement parameters)
    {
        CleanupExpiredAutomationLease();
        AutomationLease lease;
        lock (AutomationLeaseLock)
        {
            if (CurrentAutomationLease is not null)
            {
                throw new HelperException("automation_lease_busy", $"Automation lease is already active: {CurrentAutomationLease.LeaseId}");
            }

            var ttlMs = Math.Max(500, Math.Min(60_000, (int)(ReadInt64(parameters, "ttlMs") ?? 10_000)));
            var now = DateTimeOffset.UtcNow;
            var foreground = GetForegroundWindowSnapshot();
            var expectedForeground = IsWeChatForeground(foreground)
                ? foreground
                : SelectBestWindow() is { } window
                    ? new ForegroundWindowSnapshot(window.Handle, (uint)window.ProcessId, "WeChat", window.Title, window.ClassName)
                    : foreground;
            lease = new AutomationLease(
                Guid.NewGuid().ToString("N"),
                ReadString(parameters, "owner") ?? "wechat-channel",
                ReadString(parameters, "purpose") ?? "automation",
                now,
                now.AddMilliseconds(ttlMs),
                GetLastInputTick() ?? Environment.TickCount64,
                expectedForeground);
            CurrentAutomationLease = lease;
        }
        return AutomationLeasePayload(lease, active: true);
    }

    private static object AutomationLeaseRelease(JsonElement parameters)
    {
        CleanupExpiredAutomationLease();
        var leaseId = ReadString(parameters, "leaseId") ?? "";
        lock (AutomationLeaseLock)
        {
            if (CurrentAutomationLease is not null && CurrentAutomationLease.LeaseId == leaseId)
            {
                CurrentAutomationLease = null;
                return new { released = true, leaseId, active = false };
            }
            return new
            {
                released = false,
                leaseId,
                active = CurrentAutomationLease is not null,
            };
        }
    }

    private static object AutomationLeaseStatus()
    {
        CleanupExpiredAutomationLease();
        lock (AutomationLeaseLock)
        {
            if (CurrentAutomationLease is null) return new { active = false };
            RefreshAutomationLeaseInterruptionLocked();
            return AutomationLeasePayload(CurrentAutomationLease, active: true);
        }
    }

    private static object AutomationLeaseSimulateInterruption(JsonElement parameters)
    {
        CleanupExpiredAutomationLease();
        var reason = NormalizeAutomationInterruptionReason(ReadString(parameters, "reason") ?? "frontmost_app_changed");
        lock (AutomationLeaseLock)
        {
            if (CurrentAutomationLease is null)
            {
                return new
                {
                    active = false,
                    simulated = false,
                    reason,
                };
            }
            if (CurrentAutomationLease.InterruptedAt is null)
            {
                CurrentAutomationLease = CurrentAutomationLease with
                {
                    InterruptedAt = DateTimeOffset.UtcNow,
                    InterruptReason = reason,
                };
            }
            return MergePayload(AutomationLeasePayload(CurrentAutomationLease, active: true), new { simulated = true });
        }
    }

    private static void CleanupExpiredAutomationLease()
    {
        lock (AutomationLeaseLock)
        {
            if (CurrentAutomationLease is not null && CurrentAutomationLease.ExpiresAt <= DateTimeOffset.UtcNow)
            {
                CurrentAutomationLease = null;
            }
        }
    }

    private static void RefreshAutomationLeaseInterruptionLocked()
    {
        if (CurrentAutomationLease is null || CurrentAutomationLease.InterruptedAt is not null) return;

        var foreground = GetForegroundWindowSnapshot();
        if (!ForegroundMatchesExpected(foreground, CurrentAutomationLease.ExpectedForeground))
        {
            CurrentAutomationLease = CurrentAutomationLease with
            {
                InterruptedAt = DateTimeOffset.UtcNow,
                InterruptReason = "frontmost_app_changed",
            };
        }
    }

    private static object AutomationLeasePayload(AutomationLease lease, bool active)
        => new
        {
            active,
            leaseId = lease.LeaseId,
            owner = lease.Owner,
            purpose = lease.Purpose,
            acquiredAt = lease.AcquiredAt,
            expiresAt = lease.ExpiresAt,
            interrupted = lease.InterruptedAt is not null,
            interruptedAt = lease.InterruptedAt,
            interruptReason = lease.InterruptReason,
            expectedFrontmostApp = lease.ExpectedForeground,
            frontmostApp = GetForegroundWindowSnapshot(),
        };

    private static bool ForegroundMatchesExpected(ForegroundWindowSnapshot? foreground, ForegroundWindowSnapshot? expected)
    {
        if (expected is null || foreground is null) return true;
        if (foreground.Handle == expected.Handle) return true;
        if (IsWeChatForeground(foreground)) return true;
        return false;
    }

    private static bool IsWeChatForeground(ForegroundWindowSnapshot? foreground)
        => foreground is not null
            && foreground.ProcessName is "Weixin" or "WeChat" or "WeChatAppEx";

    private static string NormalizeAutomationInterruptionReason(string reason)
        => reason switch
        {
            "frontmost_app_changed" => "frontmost_app_changed",
            "user_activity_unknown" => "user_activity_unknown",
            _ => "user_activity_unknown",
        };

    private static object MergePayload(object left, object right)
    {
        var values = new Dictionary<string, object?>();
        foreach (var property in left.GetType().GetProperties()) values[property.Name] = property.GetValue(left);
        foreach (var property in right.GetType().GetProperties()) values[property.Name] = property.GetValue(right);
        return values;
    }
}
