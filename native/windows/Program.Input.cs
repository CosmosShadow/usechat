// @arch docs/features/wechat-rpa/windows-runtime.md
// @test src/__tests__/wechat-channel-windows-helper-source.test.ts

using System.Drawing;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Windows.Forms;

namespace Shennian.WeChatChannel.Helper.Win;

internal static partial class Program
{
    private static long LastAutomationInputTickValue;

    internal static void JitteredSleep(int baseMs, double jitterRatio = 0.30)
    {
        if (baseMs <= 0) return;
        var clamped = Math.Clamp(jitterRatio, 0.0, 0.5);
        var spread = baseMs * clamped;
        var min = baseMs - spread;
        var max = baseMs + spread;
        var value = min + Random.Shared.NextDouble() * (max - min);
        var ms = Math.Max(0, (int)Math.Round(value));
        Thread.Sleep(ms);
    }

    // "Human reaction" pause for the moments WeChat's anti-RPA self-protection
    // watches most closely: right after a window is brought to the foreground
    // and immediately before a paste or Enter. A real person never activates a
    // window and types in the same instant, so we wait a wide, truly-random
    // interval with a hard floor. Unlike JitteredSleep this uses a larger ratio
    // and never drops below the floor, which is what breaks the regular cadence
    // that gets us flagged. Floor/ratio are env-tunable so the timing can be
    // dialed against throughput without rebuilding the helper.
    internal static void HumanReactionSleep(int baseMs)
    {
        var floorMs = HumanReactionFloorMs();
        var effectiveBase = Math.Max(baseMs, floorMs);
        var ratio = HumanReactionJitterRatio();
        var spread = effectiveBase * ratio;
        var min = effectiveBase - spread;
        var max = effectiveBase + spread;
        var value = min + Random.Shared.NextDouble() * (max - min);
        var ms = Math.Max(floorMs, (int)Math.Round(value));
        Thread.Sleep(ms);
    }

    private static int HumanReactionFloorMs()
    {
        var raw = Environment.GetEnvironmentVariable("SHENNIAN_WECHAT_HUMAN_REACTION_FLOOR_MS");
        if (int.TryParse(raw, out var parsed) && parsed >= 0) return Math.Min(parsed, 5_000);
        return 260;
    }

    private static double HumanReactionJitterRatio()
    {
        var raw = Environment.GetEnvironmentVariable("SHENNIAN_WECHAT_HUMAN_REACTION_JITTER");
        if (double.TryParse(raw, out var parsed) && parsed >= 0) return Math.Clamp(parsed, 0.0, 0.9);
        return 0.45;
    }

    private static object MouseClick(JsonElement parameters, bool rightButton)
    {
        var pointElement = ReadPointElement(parameters);
        var point = ReadMousePoint(parameters, pointElement);
        var coordinateSpace = ReadString(pointElement, "coordinateSpace") ?? ReadString(parameters, "coordinateSpace") ?? "screen";
        var windowHandle = ReadWindowId(parameters);
        if (windowHandle is not null)
        {
            EnsureForegroundHandle(new IntPtr(windowHandle.Value));
        }
        var screenPoint = coordinateSpace switch
        {
            "screen" or "screenPixel" => point,
            "screenshotPixel" or "window" => WindowPointToScreenPoint(point),
            _ => throw new HelperException("mouse_coordinate_space_unsupported", $"Unsupported mouse coordinateSpace: {coordinateSpace}"),
        };
        // ClickScreenPoint smooth-moves the cursor to the target, so no
        // separate teleport here.
        ClickScreenPoint(screenPoint, rightButton);
        return new
        {
            clicked = true,
            button = rightButton ? "right" : "left",
            x = screenPoint.X,
            y = screenPoint.Y,
            coordinateSpace = "screen",
            input = new { point.X, point.Y, coordinateSpace },
        };
    }

    private static Point ReadMousePoint(JsonElement parameters, JsonElement pointElement)
    {
        try
        {
            return ReadPoint(pointElement);
        }
        catch (HelperException error) when (error.Code == "mouse_point_missing")
        {
            throw new HelperException("mouse_point_missing", $"Mouse command requires x and y ({DescribeJsonKeys(parameters)})");
        }
    }

    private static object MouseScroll(JsonElement parameters)
    {
        var deltaY = (int)(ReadInt64(parameters, "deltaY") ?? 0);
        var deltaX = (int)(ReadInt64(parameters, "deltaX") ?? 0);
        if (deltaY == 0 && deltaX == 0) throw new HelperException("mouse_scroll_missing", "mouse.scroll requires deltaY or deltaX");
        if (parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty("point", out var pointElement))
        {
            var point = ReadPoint(pointElement);
            var coordinateSpace = ReadString(pointElement, "coordinateSpace") ?? "screen";
            var screenPoint = coordinateSpace switch
            {
                "screen" or "screenPixel" => point,
                "screenshotPixel" or "window" => WindowPointToScreenPoint(point),
                _ => throw new HelperException("mouse_coordinate_space_unsupported", $"Unsupported mouse coordinateSpace: {coordinateSpace}"),
            };
            SmoothMoveCursor(screenPoint);
        }
        if (deltaY != 0)
        {
            mouse_event(MouseEventWheel, 0, 0, unchecked((uint)deltaY), UIntPtr.Zero);
            MarkAutomationInput();
        }
        if (deltaX != 0)
        {
            mouse_event(MouseEventHorizontalWheel, 0, 0, unchecked((uint)deltaX), UIntPtr.Zero);
            MarkAutomationInput();
        }
        return new
        {
            scrolled = true,
            deltaY,
            deltaX,
        };
    }

    // WeChat's anti-RPA watches the cursor *path*, not just the final point. A
    // single SetCursorPos that teleports the pointer straight to the target is
    // the clearest non-human tell (a real pointer traces a continuous arc with
    // acceleration). Replace the teleport with a multi-step eased trajectory:
    // step count scales with distance, an ease-in-out curve makes the ends slow
    // and the middle fast the way a hand accelerates then settles, each interior
    // sample gets a small random offset so the line isn't ruler-straight, and a
    // short jittered sleep between steps spreads the whole move over a
    // human-scale span. The final step lands exactly on target.
    private static void SmoothMoveCursor(Point target)
    {
        if (!GetCursorPos(out var origin))
        {
            // Can't read the current pointer — fall back to a direct move so the
            // action never stalls.
            if (!SetCursorPos(target.X, target.Y))
            {
                throw new HelperException("mouse_move_failed", $"Cannot move cursor to {target.X},{target.Y}");
            }
            MarkAutomationInput();
            return;
        }
        var dx = target.X - origin.X;
        var dy = target.Y - origin.Y;
        var distance = Math.Sqrt(dx * (double)dx + dy * (double)dy);
        if (distance < 2)
        {
            if (!SetCursorPos(target.X, target.Y))
            {
                throw new HelperException("mouse_move_failed", $"Cannot move cursor to {target.X},{target.Y}");
            }
            MarkAutomationInput();
            return;
        }
        // ~22px per step, clamped to 8..48: short hops still get a few frames of
        // travel, long sweeps don't grow without bound.
        var steps = Math.Clamp((int)Math.Round(distance / 22.0), 8, 48);
        for (var i = 1; i <= steps; i += 1)
        {
            var t = (double)i / steps;
            // smoothstep ease-in-out: slow at both ends, fast through the middle.
            var eased = t * t * (3 - 2 * t);
            var x = origin.X + dx * eased;
            var y = origin.Y + dy * eased;
            if (i < steps)
            {
                // ±1.5px wobble on interior samples; the last step is exact.
                x += (Random.Shared.NextDouble() - 0.5) * 3.0;
                y += (Random.Shared.NextDouble() - 0.5) * 3.0;
            }
            if (!SetCursorPos((int)Math.Round(x), (int)Math.Round(y)))
            {
                throw new HelperException("mouse_move_failed", $"Cannot move cursor to {target.X},{target.Y}");
            }
            Thread.Sleep(3 + Random.Shared.Next(0, 7));
        }
        MarkAutomationInput();
    }

    private static void ClickScreenPoint(Point point, bool rightButton)
    {
        SmoothMoveCursor(point);
        JitteredSleep(40, 0.25);
        var downFlag = rightButton ? MouseEventRightDown : MouseEventLeftDown;
        var upFlag = rightButton ? MouseEventRightUp : MouseEventLeftUp;
        mouse_event(downFlag, 0, 0, 0, UIntPtr.Zero);
        JitteredSleep(90, 0.30);
        mouse_event(upFlag, 0, 0, 0, UIntPtr.Zero);
        MarkAutomationInput();
    }

    private static object KeyboardShortcut(JsonElement parameters)
    {
        var key = ReadString(parameters, "key");
        if (string.IsNullOrWhiteSpace(key)) throw new HelperException("keyboard_key_missing", "keyboard.shortcut requires key");
        var modifiers = ReadStringArray(parameters, "modifiers")
            .Select(static modifier => modifier.Trim().ToLowerInvariant())
            .Where(static modifier => modifier.Length > 0)
            .ToArray();
        PressShortcut(VirtualKeyForKey(key), modifiers.Select(VirtualKeyForModifier).ToArray());
        return new
        {
            pressed = true,
            key,
            modifiers,
        };
    }

    private static object KeyboardType(JsonElement parameters)
    {
        var text = ReadString(parameters, "text");
        if (text is null) throw new HelperException("helper_invalid_response", "keyboard.type requires text");
        RunClipboardOperation("keyboard.type.clipboard", () =>
        {
            Clipboard.SetText(text, TextDataFormat.UnicodeText);
            return true;
        });
        PressShortcut((ushort)'V', [VirtualKeyControl]);
        return new
        {
            typed = true,
            strategy = "clipboard-paste",
            changeCount = GetClipboardSequenceNumber(),
        };
    }

    private static object KeyboardPrimeTextPaste()
    {
        SendKeyboardInputs([KeyInput(VirtualKeyShift, keyDown: true)]);
        JitteredSleep(40);
        SendKeyboardInputs([KeyInput(VirtualKeyShift, keyDown: false)]);
        MarkAutomationInput();
        JitteredSleep(40);
        return new
        {
            primed = true,
            strategy = "shift-keyboard-input",
        };
    }

    private static ushort VirtualKeyForKey(string key)
    {
        var normalized = key.Trim().ToLowerInvariant();
        return normalized switch
        {
            "return" or "enter" => VirtualKeyReturn,
            "escape" or "esc" => VirtualKeyEscape,
            "pagedown" or "page_down" or "page-down" => VirtualKeyPageDown,
            "pageup" or "page_up" or "page-up" => VirtualKeyPageUp,
            "end" => VirtualKeyEnd,
            "home" => VirtualKeyHome,
            "tab" => VirtualKeyTab,
            "space" => VirtualKeySpace,
            "backspace" or "delete" => VirtualKeyBack,
            _ when normalized.Length == 1 && normalized[0] >= 'a' && normalized[0] <= 'z' => (ushort)char.ToUpperInvariant(normalized[0]),
            _ when normalized.Length == 1 && normalized[0] >= '0' && normalized[0] <= '9' => (ushort)normalized[0],
            _ => throw new HelperException("keyboard_key_unsupported", $"Unsupported key: {key}"),
        };
    }

    private static ushort VirtualKeyForModifier(string modifier)
        => modifier switch
        {
            "shift" => VirtualKeyShift,
            "control" or "ctrl" or "command" or "cmd" or "meta" => VirtualKeyControl,
            "alt" or "option" => VirtualKeyMenu,
            _ => throw new HelperException("keyboard_modifier_unsupported", $"Unsupported modifier: {modifier}"),
        };

    private static void PressShortcut(ushort key, ushort[] modifiers)
    {
        // WeChat's anti-RPA watches for synthetic-input fingerprints. The two
        // tells that get us flagged (and the composer paste silently dropped,
        // then the shell torn down) are: (1) keystrokes with no hardware scan
        // code, and (2) a whole chord delivered as one zero-interval SendInput
        // batch. Real keyboards emit scan codes and put human-scale gaps
        // between press/release transitions. So we attach the mapped scan code
        // (see KeyInput) and send each transition as its own SendInput with a
        // short jittered sleep between them, modifiers wrapping the key the way
        // a hand actually rolls onto Ctrl before tapping V.
        foreach (var modifier in modifiers)
        {
            SendKeyboardInputs([KeyInput(modifier, keyDown: true)]);
            JitteredSleep(28, 0.6);
        }
        SendKeyboardInputs([KeyInput(key, keyDown: true)]);
        JitteredSleep(40, 0.6);
        SendKeyboardInputs([KeyInput(key, keyDown: false)]);
        JitteredSleep(28, 0.6);
        foreach (var modifier in modifiers.Reverse())
        {
            SendKeyboardInputs([KeyInput(modifier, keyDown: false)]);
            JitteredSleep(24, 0.6);
        }
        MarkAutomationInput();
        JitteredSleep(40);
    }

    private static void MarkAutomationInput()
    {
        Interlocked.Exchange(ref LastAutomationInputTickValue, Environment.TickCount64);
    }

    private static long? LastAutomationInputTick()
    {
        var tick = Interlocked.Read(ref LastAutomationInputTickValue);
        return tick > 0 ? tick : null;
    }

    private static bool IsLastInputAutomationOwned(long? lastInputTick)
    {
        if (lastInputTick is null) return false;
        var automationTick = LastAutomationInputTick();
        if (automationTick is null) return false;
        var deltaMs = Math.Abs(lastInputTick.Value - automationTick.Value);
        return deltaMs <= 2_000;
    }

    private static INPUT KeyInput(ushort virtualKey, bool keyDown)
    {
        // Attach the hardware scan code and set KEYEVENTF_SCANCODE so the event
        // carries the same low-level signature a physical key emits. Without
        // this the Scan field is 0, which anti-RPA reads as injected input.
        var scan = (ushort)MapVirtualKey(virtualKey, MapVkToScan);
        var flags = keyDown ? 0u : KeyEventKeyUp;
        if (scan != 0) flags |= KeyEventScanCode;
        return new()
        {
            Type = InputKeyboard,
            Data = new InputUnion
            {
                Keyboard = new KEYBDINPUT
                {
                    VirtualKey = virtualKey,
                    Scan = scan,
                    Flags = flags,
                    Time = 0,
                    ExtraInfo = UIntPtr.Zero,
                },
            },
        };
    }

    private static void SendKeyboardInputs(List<INPUT> inputs)
    {
        if (inputs.Count == 0) return;
        var sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf<INPUT>());
        if (sent != inputs.Count)
        {
            var error = Marshal.GetLastWin32Error();
            throw new HelperException("keyboard_send_failed", $"SendInput sent {sent}/{inputs.Count} events (win32={error})");
        }
    }
}
