// @arch docs/features/wechat-rpa/windows-runtime.md
// @test src/__tests__/wechat-channel-windows-helper-source.test.ts

using System.Drawing;
using System.Drawing.Imaging;
using System.Text.Json;
using RapidOcrNet;

namespace UseChat.WeChatChannel.Helper.Win;

internal static partial class Program
{
    private static readonly object OcrLock = new();
    private static RapidOcr? OcrEngine;
    private static string? OcrModelKey;
    private const string PackagedChineseOcrModelName = "packaged-ppocrv5-chinese";

    private static object OcrRecognize(JsonElement parameters)
    {
        var imagePath = ReadString(parameters, "imagePath") ?? ReadString(parameters, "path");
        string? tempImagePath = null;
        string? tempCropImagePath = null;
        Bounds? crop = null;
        var cropOffsetX = 0;
        var cropOffsetY = 0;
        if (string.IsNullOrWhiteSpace(imagePath))
        {
            var dataBase64 = ReadString(parameters, "dataBase64");
            if (string.IsNullOrWhiteSpace(dataBase64)) throw new HelperException("ocr_image_missing", "ocr.recognize requires imagePath or dataBase64");
            var tempDir = Path.Combine(Path.GetTempPath(), "shennian-wechat-channel-ocr");
            Directory.CreateDirectory(tempDir);
            tempImagePath = Path.Combine(tempDir, $"{Guid.NewGuid():N}.png");
            File.WriteAllBytes(tempImagePath, Convert.FromBase64String(dataBase64));
            imagePath = tempImagePath;
        }
        try
        {
            if (!File.Exists(imagePath)) throw new HelperException("ocr_image_missing", $"OCR image does not exist: {imagePath}");
            var sourceImagePath = imagePath;
            crop = ReadCrop(parameters);
            if (crop is not null)
            {
                if (crop.X < 0 || crop.Y < 0 || crop.Width <= 0 || crop.Height <= 0)
                {
                    throw new HelperException("ocr_crop_invalid", $"OCR crop is invalid: {crop}");
                }
                using var sourceBitmap = new Bitmap(imagePath);
                if (crop.X + crop.Width > sourceBitmap.Width || crop.Y + crop.Height > sourceBitmap.Height)
                {
                    throw new HelperException("ocr_crop_out_of_bounds", $"OCR crop is outside image bounds: crop={crop}, image={sourceBitmap.Width}x{sourceBitmap.Height}");
                }
                var tempDir = Path.Combine(Path.GetTempPath(), "shennian-wechat-channel-ocr");
                Directory.CreateDirectory(tempDir);
                tempCropImagePath = Path.Combine(tempDir, $"{Guid.NewGuid():N}-crop.png");
                using var croppedBitmap = sourceBitmap.Clone(new Rectangle(crop.X, crop.Y, crop.Width, crop.Height), PixelFormat.Format32bppArgb);
                croppedBitmap.Save(tempCropImagePath, ImageFormat.Png);
                imagePath = tempCropImagePath;
                cropOffsetX = crop.X;
                cropOffsetY = crop.Y;
            }

            var run = RunOcr(imagePath, parameters, cropOffsetX, cropOffsetY);
            using var outputBitmap = new Bitmap(imagePath);
            return new
            {
                provider = run.Provider,
                engine = run.Engine,
                modelSet = run.ModelSet,
                language = run.Language,
                durationMs = run.DurationMs,
                detectTimeMs = run.DetectTimeMs,
                dbNetTimeMs = run.DbNetTimeMs,
                imagePath = tempImagePath is null ? sourceImagePath : null,
                input = tempImagePath is null ? "file" : "dataBase64",
                crop,
                blockCount = run.Blocks.Length,
                text = run.Text,
                blocks = run.Blocks,
                visibleConversationFingerprints = VisibleConversationFingerprints(run.Blocks, outputBitmap.Width, outputBitmap.Height),
            };
        }
        finally
        {
            if (tempCropImagePath is not null) File.Delete(tempCropImagePath);
            if (tempImagePath is not null) File.Delete(tempImagePath);
        }
    }

    private static OcrRunResult RunOcr(string imagePath, JsonElement parameters, int offsetX = 0, int offsetY = 0)
    {
        var detPath = ReadString(parameters, "detPath");
        var clsPath = ReadString(parameters, "clsPath");
        var recPath = ReadString(parameters, "recPath");
        var keysPath = ReadString(parameters, "keysPath");
        var customModelPaths = new[] { detPath, clsPath, recPath, keysPath }.Any(static value => !string.IsNullOrWhiteSpace(value));
        if (customModelPaths)
        {
            RequireExistingModelFile(detPath, "detPath");
            RequireExistingModelFile(clsPath, "clsPath");
            RequireExistingModelFile(recPath, "recPath");
            RequireExistingModelFile(keysPath, "keysPath");
        }

        var textScore = ReadSingle(parameters, "textScore");
        var options = textScore is null
            ? RapidOcrOptions.Default with
            {
                ReturnWordBox = ReadBool(parameters, "returnWordBox") ?? true,
                ReturnSingleCharBox = ReadBool(parameters, "returnSingleCharBox") ?? false,
                DoAngle = ReadBool(parameters, "doAngle") ?? false,
            }
            : RapidOcrOptions.Default with
            {
                ReturnWordBox = ReadBool(parameters, "returnWordBox") ?? true,
                ReturnSingleCharBox = ReadBool(parameters, "returnSingleCharBox") ?? false,
                DoAngle = ReadBool(parameters, "doAngle") ?? false,
                TextScore = textScore.Value,
            };

        var packagedModels = customModelPaths ? null : ResolvePackagedChineseOcrModels();
        var numThreads = (int)(ReadInt64(parameters, "numThreads") ?? 0);
        var modelKey = customModelPaths
            ? string.Join("|", detPath, clsPath, recPath, keysPath, numThreads)
            : packagedModels is not null
                ? string.Join("|", packagedModels.DetPath, packagedModels.ClsPath, packagedModels.RecPath, packagedModels.KeysPath, numThreads)
                : $"default|{numThreads}";
        var started = DateTimeOffset.UtcNow;
        lock (OcrLock)
        {
            if (OcrEngine is null || OcrModelKey != modelKey)
            {
                OcrEngine?.Dispose();
                OcrEngine = new RapidOcr();
                if (customModelPaths)
                {
                    OcrEngine.InitModels(detPath!, clsPath!, recPath!, keysPath!, numThreads);
                }
                else if (packagedModels is not null)
                {
                    OcrEngine.InitModels(
                        packagedModels.DetPath,
                        packagedModels.ClsPath,
                        packagedModels.RecPath,
                        packagedModels.KeysPath,
                        numThreads);
                }
                else
                {
                    var baseDir = AppContext.BaseDirectory;
                    var modelDir = Path.Combine(baseDir, RapidOcr.ModelsFolderName, RapidOcr.ModelsVersion);
                    OcrEngine.InitModels(
                        Path.Combine(modelDir, RapidOcr.DefaultDetModelPath),
                        Path.Combine(modelDir, RapidOcr.DefaultClsModelPath),
                        Path.Combine(modelDir, RapidOcr.DefaultRecModelPath),
                        Path.Combine(modelDir, RapidOcr.DefaultKeysFilePath),
                        numThreads);
                }
                OcrModelKey = modelKey;
            }

            var result = OcrEngine.Detect(imagePath, options);
            var blocks = (result.TextBlocks ?? [])
                .Select(block => new OcrBlock(
                    block.Text ?? "",
                    Average(block.CharScores),
                    block.BoxScore,
                    ToPoints(block.BoxPoints, offsetX, offsetY),
                    BoundingBox(block.BoxPoints, offsetX, offsetY),
                    "screenshotPixel",
                    (block.WordResults ?? [])
                    .Select(word => new OcrWord(
                        word.Text ?? "",
                        word.Score,
                        ToPoints(word.BoxPoints, offsetX, offsetY),
                        BoundingBox(word.BoxPoints, offsetX, offsetY),
                        "screenshotPixel"))
                    .ToArray()))
                .ToArray();
            return new OcrRunResult(
                "rapidocrnet-ppocrv5",
                "rapidocrnet-ppocrv5",
                customModelPaths ? "custom" : packagedModels is not null ? PackagedChineseOcrModelName : "rapidocrnet-default-latin",
                customModelPaths ? "custom" : packagedModels is not null ? "zh" : "latin",
                ElapsedMs(started),
                result.DetectTime,
                result.DbNetTime,
                result.StrRes ?? "",
                blocks);
        }
    }

    private static OcrModelFiles? ResolvePackagedChineseOcrModels()
    {
        var modelDir = Path.Combine(AppContext.BaseDirectory, "models", "v5");
        var models = new OcrModelFiles(
            Path.Combine(modelDir, "ch_PP-OCRv5_mobile_det.onnx"),
            Path.Combine(modelDir, "ch_ppocr_mobile_v2.0_cls_infer.onnx"),
            Path.Combine(modelDir, "ch_PP-OCRv5_rec_mobile.onnx"),
            Path.Combine(modelDir, "ppocrv5_dict.txt"));
        return File.Exists(models.DetPath)
            && File.Exists(models.ClsPath)
            && File.Exists(models.RecPath)
            && File.Exists(models.KeysPath)
            ? models
            : null;
    }

    private static void RequireExistingModelFile(string? filePath, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(filePath)) throw new HelperException("ocr_model_missing", $"ocr.recognize requires {parameterName} when custom OCR models are used");
        if (!File.Exists(filePath)) throw new HelperException("ocr_model_missing", $"OCR model file does not exist: {parameterName}={filePath}");
    }

    private static object[] ToPoints(SkiaSharp.SKPointI[]? points, int offsetX = 0, int offsetY = 0)
        => (points ?? [])
            .Select(point => new { x = point.X + offsetX, y = point.Y + offsetY })
            .Cast<object>()
            .ToArray();

    private static Bounds? BoundingBox(SkiaSharp.SKPointI[]? points, int offsetX = 0, int offsetY = 0)
    {
        if (points is null || points.Length == 0) return null;
        var minX = points.Min(static point => point.X) + offsetX;
        var minY = points.Min(static point => point.Y) + offsetY;
        var maxX = points.Max(static point => point.X) + offsetX;
        var maxY = points.Max(static point => point.Y) + offsetY;
        return new Bounds(minX, minY, Math.Max(0, maxX - minX), Math.Max(0, maxY - minY));
    }

    private static double? Average(float[]? values)
    {
        if (values is null || values.Length == 0) return null;
        return Math.Round(values.Average(), 4);
    }
}
