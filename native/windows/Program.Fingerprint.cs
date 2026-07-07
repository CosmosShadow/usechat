// @arch docs/features/wechat-rpa/windows-runtime.md
// @test src/__tests__/wechat-channel-windows-helper-source.test.ts

using System.Text.RegularExpressions;

namespace UseChat.WeChatChannel.Helper.Win;

internal static partial class Program
{
    // 会话列表指纹行聚类 —— 与 .dev-runtime/fingerprint-cluster-ref.mjs / Mac helper 保持完全一致的几何规则。
    // 阈值全部用百分比(相对截图宽高),不写死像素,兼容不同窗口尺寸。
    // 标题/预览同列(x≈10-20%W);时间/日期列(x≈24-36%W)与标题同一水平行;排除顶栏(y<12%H)。
    private static object[] VisibleConversationFingerprints(OcrBlock[] blocks, int width, int height)
    {
        var items = new List<FingerprintItem>();
        foreach (var block in blocks)
        {
            var bbox = block.Bbox;
            if (bbox is null) continue;
            var text = NormalizeVisibleConversationTitle(block.Text);
            if (text.Length < 1 || IsNoiseText(text)) continue;
            items.Add(new FingerprintItem(text, bbox.X, bbox.Y, bbox.Width, bbox.Height));
        }

        double titleXLo = width * 0.10, titleXHi = width * 0.20;
        double timeXLo = width * 0.24, timeXHi = width * 0.36;
        double topBarY = height * 0.12;
        double bottomY = height * 0.96;
        double rowYTol = height * 0.02;
        // Windows 标题↔预览≈3.3%H;Mac 标题↔预览≈2.4%H。取 4%H,既能吸预览又不并下一行(Mac 行距 7%H)。
        double titleGap = height * 0.04;

        bool InTitleCol(FingerprintItem b) => b.X > titleXLo && b.X < titleXHi;
        bool InTimeCol(FingerprintItem b) => b.X > timeXLo && b.X < timeXHi;

        // 左列文本(标题/预览候选),避开顶栏。
        var leftCol = items
            .Where(b => InTitleCol(b) && b.Y > topBarY && b.Y < bottomY)
            .Where(b => !IsNonConversationListText(b.Text))
            .OrderBy(b => b.Y).ThenBy(b => b.X)
            .ToList();

        // 时间列块(每个会话行右侧的时间/日期),作为行锚骨架。
        var timeBlocks = items
            .Where(b => InTimeCol(b) && b.Y > topBarY && b.Y < bottomY && IsLikelyTimeText(b.Text))
            .OrderBy(b => b.Y)
            .ToList();

        // 候选标题:左列、非时间,且上方 titleGap 内无更靠上的左列块。
        var titleBoxes = leftCol
            .Where(b => !IsLikelyTimeText(b.Text))
            .Where(b => !leftCol.Any(o => !ReferenceEquals(o, b) && o.Y < b.Y && b.Y - o.Y < titleGap))
            .OrderBy(b => b.Y)
            .ToList();

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<object>();
        for (var i = 0; i < titleBoxes.Count; i++)
        {
            var titleBox = titleBoxes[i];
            double nextTitleY = i + 1 < titleBoxes.Count ? titleBoxes[i + 1].Y : double.PositiveInfinity;
            // 预览:本标题与下一标题之间、同列的左列块(取第一条非时间)。
            var previewBox = leftCol.FirstOrDefault(b =>
                !ReferenceEquals(b, titleBox) && b.Y > titleBox.Y && b.Y < nextTitleY && !IsLikelyTimeText(b.Text));
            // 时间:与标题同一水平行的时间块。
            var timeBox = timeBlocks.FirstOrDefault(b => Math.Abs(b.Cy - titleBox.Cy) <= rowYTol);

            var title = titleBox.Text;
            var preview = previewBox?.Text;
            var timeText = timeBox?.Text;
            var fingerprint = string.Join("|", new[] { title, preview, timeText }.Where(s => !string.IsNullOrEmpty(s)));
            if (!seen.Add(title)) continue;
            result.Add(new
            {
                title,
                preview,
                timeText,
                unreadText = (string?)null,
                fingerprint,
                // bbox = 标题行点击目标(供 CLI 点击会话用),沿用 width/height 命名。
                bbox = new
                {
                    x = titleBox.X,
                    y = titleBox.Y,
                    width = titleBox.W,
                    height = titleBox.H,
                    coordinateSpace = "screenshotPixel",
                },
                titleBox = BoxOf(titleBox),
                timeBox = BoxOf(timeBox),
                previewBox = BoxOf(previewBox),
            });
        }
        return result.ToArray();
    }

    private sealed class FingerprintItem(string text, int x, int y, int w, int h)
    {
        public string Text { get; } = text;
        public int X { get; } = x;
        public int Y { get; } = y;
        public int W { get; } = w;
        public int H { get; } = h;
        public double Cx => X + W / 2.0;
        public double Cy => Y + H / 2.0;
    }

    private static object? BoxOf(FingerprintItem? b)
        => b is null ? null : new { x = b.X, y = b.Y, w = b.W, h = b.H, coordinateSpace = "screenshotPixel" };

    private static readonly Regex[] TimeRegexes =
    [
        new(@"^(星期[一二三四五六日天])$", RegexOptions.Compiled),
        new(@"^(周[一二三四五六日天])\s*\d{0,2}:?\d{0,2}$", RegexOptions.Compiled),
        new(@"^(昨天|今天|前天)\s*\d{1,2}:\d{2}$", RegexOptions.Compiled),
        new(@"^\d{1,2}:\d{2}(?::\d{2})?$", RegexOptions.Compiled),
        new(@"^\d{4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?$", RegexOptions.Compiled),
        new(@"^\d{1,2}[-/.月]\d{1,2}日?$", RegexOptions.Compiled),
    ];

    private static bool IsLikelyTimeText(string text)
    {
        var v = (text ?? string.Empty).Trim();
        return TimeRegexes.Any(re => re.IsMatch(v));
    }

    private static bool IsNoiseText(string text)
    {
        var v = text.Trim();
        if (v.Length <= 1) return true;
        if (Regex.IsMatch(v, @"^[•·⋯…]+$")) return true;
        if (Regex.IsMatch(v, @"^[①-⓿❶-➓]+$")) return true;
        return false;
    }

    private static string NormalizeVisibleConversationTitle(string value)
        => string.Join(" ", (value ?? string.Empty).Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    private static bool IsNonConversationListText(string title)
    {
        var blocked = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "搜索",
            "微信",
            "通讯录",
            "收藏",
            "设置",
            "Search",
        };
        return blocked.Contains(title.Trim());
    }
}
