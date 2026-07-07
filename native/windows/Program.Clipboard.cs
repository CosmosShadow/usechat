// @arch docs/features/wechat-rpa/windows-runtime.md
// @test src/__tests__/wechat-channel-windows-helper-source.test.ts

using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Windows.Forms;

namespace UseChat.WeChatChannel.Helper.Win;

internal static partial class Program
{
    private const int ClipboardOperationTimeoutMs = 2_500;
    private static readonly string[] PreferredClipboardSnapshotFormats =
    [
        DataFormats.UnicodeText,
        DataFormats.Text,
        DataFormats.Html,
        DataFormats.Rtf,
        DataFormats.FileDrop,
    ];

    private static object ClipboardSnapshot()
    {
        return RunClipboardOperation("clipboard.snapshot", static () =>
        {
            var items = new List<object>();
            var data = Clipboard.GetDataObject();
            if (data is not null)
            {
                foreach (var format in PreferredClipboardSnapshotFormats)
                {
                    if (TryReadClipboardFormat(data, format, out var typeInfo))
                    {
                        items.Add(new { types = new[] { typeInfo } });
                    }
                }
                if (TryReadClipboardImage(out var imageInfo))
                {
                    items.Add(new { types = new[] { imageInfo } });
                }
            }
            return new
            {
                changeCount = GetClipboardSequenceNumber(),
                items,
            };
        });
    }

    private static object ClipboardRestore(JsonElement parameters)
    {
        return RunClipboardOperation("clipboard.restore", () =>
        {
            var collection = new DataObject();
            var restoredTypes = 0;
            if (parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in items.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("types", out var types) || types.ValueKind != JsonValueKind.Array) continue;
                    foreach (var typeInfo in types.EnumerateArray())
                    {
                        if (RestoreClipboardFormat(collection, typeInfo)) restoredTypes++;
                    }
                }
            }
            if (restoredTypes > 0)
            {
                Clipboard.SetDataObject(collection, copy: true);
            }
            else
            {
                Clipboard.Clear();
            }
            return new
            {
                restored = true,
                itemCount = restoredTypes,
                changeCount = GetClipboardSequenceNumber(),
            };
        }, errorCode: "clipboard_restore_failed");
    }

    private static object ClipboardSetText(JsonElement parameters)
    {
        var text = ReadString(parameters, "text");
        if (text is null) throw new HelperException("helper_invalid_response", "clipboard.setText requires text");
        return RunClipboardOperation("clipboard.setText", () =>
        {
            Clipboard.SetText(text, TextDataFormat.UnicodeText);
            return new
            {
                ok = true,
                changeCount = GetClipboardSequenceNumber(),
            };
        });
    }

    private static object ClipboardSetFiles(JsonElement parameters)
    {
        var filePaths = ReadStringArray(parameters, "filePaths");
        if (filePaths.Length == 0) filePaths = ReadStringArray(parameters, "paths");
        if (filePaths.Length == 0) throw new HelperException("helper_invalid_response", "clipboard.setFiles requires filePaths");
        var resolved = filePaths
            .Select(static filePath => Path.GetFullPath(filePath.Trim()))
            .Where(static filePath => !string.IsNullOrWhiteSpace(filePath))
            .ToArray();
        foreach (var filePath in resolved)
        {
            if (!File.Exists(filePath)) throw new HelperException("attachment_unavailable", $"Attachment does not exist: {filePath}");
        }
        return RunClipboardOperation("clipboard.setFiles", () =>
        {
            var collection = new System.Collections.Specialized.StringCollection();
            collection.AddRange(resolved);
            Clipboard.SetFileDropList(collection);
            return new
            {
                ok = true,
                fileCount = resolved.Length,
                changeCount = GetClipboardSequenceNumber(),
            };
        });
    }

    private static object ClipboardSetImage(JsonElement parameters)
    {
        var filePath = ReadString(parameters, "filePath") ?? ReadString(parameters, "path");
        if (string.IsNullOrWhiteSpace(filePath)) throw new HelperException("helper_invalid_response", "clipboard.setImage requires filePath");
        var resolved = Path.GetFullPath(filePath);
        if (!File.Exists(resolved)) throw new HelperException("attachment_unavailable", $"Image does not exist: {resolved}");
        return RunClipboardOperation("clipboard.setImage", () =>
        {
            using var image = Image.FromFile(resolved);
            using var bitmap = new Bitmap(image);
            Clipboard.SetImage(bitmap);
            return new
            {
                ok = true,
                changeCount = GetClipboardSequenceNumber(),
            };
        });
    }

    private static object ClipboardReadFileUrls()
    {
        return RunClipboardOperation("clipboard.readFileUrls", static () =>
        {
            var filePaths = ReadClipboardFilePaths();
            return new
            {
                filePaths,
                fileUrls = filePaths.Select(static filePath => new Uri(filePath).AbsoluteUri).ToArray(),
                changeCount = GetClipboardSequenceNumber(),
            };
        });
    }

    private static object ClipboardReadAttachment()
    {
        return RunClipboardOperation<object>("clipboard.readAttachment", static () =>
        {
            var filePaths = ReadClipboardFilePaths();
            var data = Clipboard.GetDataObject();
            var types = ReadClipboardTypeNames(data);
            if (filePaths.Length > 0)
            {
                return (object)new
                {
                    filePaths,
                    fileUrls = filePaths.Select(static filePath => new Uri(filePath).AbsoluteUri).ToArray(),
                    types,
                    changeCount = GetClipboardSequenceNumber(),
                };
            }
            if (Clipboard.ContainsImage())
            {
                using var image = Clipboard.GetImage();
                if (image is not null)
                {
                    using var stream = new MemoryStream();
                    image.Save(stream, ImageFormat.Png);
                    return (object)new
                    {
                        dataBase64 = Convert.ToBase64String(stream.ToArray()),
                        mimeType = "image/png",
                        suggestedFileName = "wechat-image.png",
                        types,
                        changeCount = GetClipboardSequenceNumber(),
                    };
                }
            }
            return (object)new
            {
                filePaths = Array.Empty<string>(),
                fileUrls = Array.Empty<string>(),
                types,
                changeCount = GetClipboardSequenceNumber(),
            };
        });
    }

    private static bool TryReadClipboardFormat(IDataObject data, string format, out object typeInfo)
    {
        typeInfo = new { type = format, dataBase64 = "" };
        try
        {
            if (!data.GetDataPresent(format, autoConvert: true)) return false;
            var value = data.GetData(format, autoConvert: true);
            if (value is null) return false;
            if (value is string text)
            {
                typeInfo = new { type = format, kind = "text", dataBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(text)) };
                return true;
            }
            if (value is MemoryStream memory)
            {
                typeInfo = new { type = format, kind = "bytes", dataBase64 = Convert.ToBase64String(memory.ToArray()) };
                return true;
            }
            if (value is byte[] bytes)
            {
                typeInfo = new { type = format, kind = "bytes", dataBase64 = Convert.ToBase64String(bytes) };
                return true;
            }
            if (value is Bitmap bitmap)
            {
                using var stream = new MemoryStream();
                bitmap.Save(stream, ImageFormat.Png);
                typeInfo = new { type = format, kind = "png", dataBase64 = Convert.ToBase64String(stream.ToArray()) };
                return true;
            }
            if (value is System.Collections.Specialized.StringCollection strings)
            {
                var textValue = string.Join("\n", strings.Cast<string>());
                typeInfo = new { type = format, kind = "stringCollection", dataBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(textValue)) };
                return true;
            }
            if (value is string[] array)
            {
                var textValue = string.Join("\n", array.Where(static item => !string.IsNullOrWhiteSpace(item)));
                typeInfo = new { type = format, kind = "stringCollection", dataBase64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(textValue)) };
                return textValue.Length > 0;
            }
        }
        catch
        {
            return false;
        }
        return false;
    }

    private static bool RestoreClipboardFormat(DataObject collection, JsonElement typeInfo)
    {
        if (typeInfo.ValueKind != JsonValueKind.Object) return false;
        var type = ReadString(typeInfo, "type");
        var base64 = ReadString(typeInfo, "dataBase64");
        var kind = ReadString(typeInfo, "kind");
        if (string.IsNullOrWhiteSpace(type) || string.IsNullOrWhiteSpace(base64)) return false;
        var bytes = Convert.FromBase64String(base64);
        try
        {
            if (kind == "text")
            {
                collection.SetData(type, Encoding.UTF8.GetString(bytes));
                return true;
            }
            if (kind == "png")
            {
                using var stream = new MemoryStream(bytes);
                collection.SetData(type, new Bitmap(stream));
                return true;
            }
            if (kind == "stringCollection")
            {
                var strings = new System.Collections.Specialized.StringCollection();
                strings.AddRange(Encoding.UTF8.GetString(bytes).Split('\n'));
                collection.SetData(type, strings);
                return true;
            }
            collection.SetData(type, new MemoryStream(bytes));
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static T RunClipboardOperation<T>(string operationName, Func<T> operation, string errorCode = "clipboard_unavailable")
    {
        object? result = null;
        Exception? failure = null;
        using var completed = new ManualResetEventSlim(false);
        var thread = new Thread(() =>
        {
            try
            {
                result = operation();
            }
            catch (Exception error)
            {
                failure = error;
            }
            finally
            {
                completed.Set();
            }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        if (!completed.Wait(ClipboardOperationTimeoutMs))
        {
            throw new HelperException(errorCode, $"{operationName} timed out after {ClipboardOperationTimeoutMs}ms");
        }
        if (failure is not null)
        {
            if (failure is HelperException helperError) throw helperError;
            var summary = failure is ExternalException
                ? $"{operationName} failed because the clipboard is busy: {failure.Message}"
                : $"{operationName} failed: {failure.Message}";
            throw new HelperException(errorCode, summary);
        }
        return (T)result!;
    }

    private static string[] ReadClipboardFilePaths()
        => Clipboard.ContainsFileDropList()
            ? Clipboard.GetFileDropList().Cast<string>().Where(static path => !string.IsNullOrWhiteSpace(path)).ToArray()
            : [];

    private static string[] ReadClipboardTypeNames(IDataObject? data)
    {
        var types = new List<string>();
        if (data is not null)
        {
            foreach (var format in PreferredClipboardSnapshotFormats)
            {
                try
                {
                    if (data.GetDataPresent(format, autoConvert: true)) types.Add(format);
                }
                catch
                {
                    // Ignore unreadable formats; the clipboard read itself should remain usable.
                }
            }
        }
        try
        {
            if (Clipboard.ContainsImage()) types.Add(DataFormats.Bitmap);
        }
        catch
        {
            // Ignore image probe failures; attachment reads can still return file URLs or text formats.
        }
        return types.Distinct(StringComparer.Ordinal).ToArray();
    }

    private static bool TryReadClipboardImage(out object typeInfo)
    {
        typeInfo = new { type = DataFormats.Bitmap, dataBase64 = "" };
        try
        {
            if (!Clipboard.ContainsImage()) return false;
            using var image = Clipboard.GetImage();
            if (image is null) return false;
            using var stream = new MemoryStream();
            image.Save(stream, ImageFormat.Png);
            typeInfo = new { type = DataFormats.Bitmap, kind = "png", dataBase64 = Convert.ToBase64String(stream.ToArray()) };
            return true;
        }
        catch
        {
            return false;
        }
    }
}
