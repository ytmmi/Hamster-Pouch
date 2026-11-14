/**
 * 面板门禁分节 · 元数据面板：宿主格式与结构化明细（原第 6–7 节）。
 *
 * D189 拆分：断言逐字搬自 tools/check-panels.mjs，顺序不变；被多节共用的源码常量与 TS 模块
 * 句柄一律从 shared.mjs 取，断言框架从 harness.mjs 取。本文件不新增依赖、不改断言口径。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, eqList, stripComments } from "./harness.mjs";
import {
  ROOT, config, format, imageViewerPanelSrc, metadataPanelSrc, preload,
  registrySource, viewerInfoBarSrc,
} from "./shared.mjs";
export default async function run() {
// ============ 元数据面板：宿主格式设置 ↔ 面板实现（体积 / 日期 / 类型自适应）============
//
// 体积单位与日期格式是**宿主项**（跨面板共用的通用口径，落在「界面 → 其他设置」），
// 因此"声明 ↔ Rust 镜像"的一致性由 `pnpm check:settings` 负责；这里断言三件这里才看得见的事：
// ① 归一化/收敛口径（越界与非法取值都回落缺省）；② 纯函数行为（格式化 + JSON 解析）；
// ③ 面板真的消费它们，并**按媒体类型**自适应渲染。

const metadataInfo = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/metadataInfo.ts")).href
);
const metadataFormat = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/panels/metadataFormat.ts")).href
);
const i18nIndex = await import(
  pathToFileURL(join(ROOT, "apps/desktop/src/app_ui/i18n/index.ts")).href
);
const metaT = i18nIndex.makeTranslator("zh-CN");
const metadataPanelCode = stripComments(metadataPanelSrc);

check(
  "「其他设置」三项宿主设置齐备（体积单位 / 日期格式 / 显示时间，类别与分节固定）",
  (() => {
    const sizeUnit = config.settingDeclByKey("ui.sizeUnit");
    const dateFormat = config.settingDeclByKey("ui.dateFormat");
    const dateShowTime = config.settingDeclByKey("ui.dateShowTime");
    return (
      sizeUnit?.kind === "select" &&
      sizeUnit.category === "interface" &&
      sizeUnit.section_key === "settings.section.other" &&
      sizeUnit.default === "binary" &&
      eqList(
        (sizeUnit.options ?? []).map((o) => o.value),
        ["binary", "decimal"],
      ) &&
      dateFormat?.default === "iso" &&
      eqList(
        (dateFormat.options ?? []).map((o) => o.value),
        ["iso", "us", "eu"],
      ) &&
      dateShowTime?.kind === "switch" &&
      dateShowTime.default === false
    );
  })(),
);

check(
  "宿主设置值归一化：越界/非法回落声明缺省、未注册键为 undefined、解析器收敛",
  config.normalizeHostSettingValue("ui.sizeUnit", "decimal") === "decimal" &&
    config.normalizeHostSettingValue("ui.sizeUnit", "kib") === "binary" &&
    config.normalizeHostSettingValue("ui.dateFormat", "us") === "us" &&
    config.normalizeHostSettingValue("ui.dateFormat", "29/09/2026") === "iso" &&
    config.normalizeHostSettingValue("ui.dateShowTime", "true") === true &&
    config.normalizeHostSettingValue("ui.dateShowTime", "yes") === false &&
    config.normalizeHostSettingValue("ui.theme", "blue") === "light" &&
    config.normalizeHostSettingValue("ui.notRegistered", true) === undefined &&
    config.resolveSizeUnit("kib") === "binary" &&
    config.resolveSizeUnit("decimal") === "decimal" &&
    config.resolveDateFormat("eu") === "eu" &&
    config.resolveDateFormat(undefined) === "iso" &&
    config.resolveDateShowTime("true") === false &&
    config.resolveDateShowTime(true) === true,
);

check(
  "体积格式化：二进制按 1024 换单位（KiB/MiB/GiB）、十进制按 1000（KB/MB/GB），都按体积自适应",
  format.formatByteSize(512, "binary") === "512 B" &&
    format.formatByteSize(1024, "binary") === "1.00 KiB" &&
    format.formatByteSize(1536, "binary") === "1.50 KiB" &&
    format.formatByteSize(1024 * 1024 * 3.5, "binary") === "3.50 MiB" &&
    format.formatByteSize(1024 ** 3, "binary") === "1.00 GiB" &&
    format.formatByteSize(1500, "decimal") === "1.50 KB" &&
    format.formatByteSize(1_000_000, "decimal") === "1.00 MB" &&
    format.formatByteSize(1_000_000_000, "decimal") === "1.00 GB" &&
    format.formatByteSize(-1, "binary") === "—" &&
    format.formatByteSize(null, "binary") === "—",
  `binary(1536)=${format.formatByteSize(1536, "binary")} decimal(1500)=${format.formatByteSize(1500, "decimal")}`,
);

// 时区无关：时间戳由**本地时间分量**构造，断言的是格式而不是某个时区下的偏移。
const localStamp = String(new Date(2026, 8, 29, 16, 2, 3).getTime() * 1e6);
check(
  "日期格式化：YYYY-MM-DD（缺省）/ MM-DD-YYYY / DD-MM-YYYY 三选，另可按开关补 HH:MM:SS",
  format.formatDateValue(localStamp, "iso", false) === "2026-09-29" &&
    format.formatDateValue(localStamp, "us", false) === "09/29/2026" &&
    format.formatDateValue(localStamp, "eu", false) === "29/09/2026" &&
    format.formatDateValue(localStamp, "iso", true) === "2026-09-29 16:02:03" &&
    format.formatDateValue("2026-09-29T16:02:03", "iso", true) === "2026-09-29 16:02:03" &&
    format.formatDateValue(null, "iso", false) === "—" &&
    format.formatDateValue("not a date", "iso", false) === "not a date",
  `iso=${format.formatDateValue(localStamp, "iso", false)} eu=${format.formatDateValue(localStamp, "eu", false)}`,
);

check(
  "时长/码率/帧率格式化：M:SS 与 H:MM:SS、十进制码率、两位小数帧率",
  format.formatDurationMs(0) === "0:00" &&
    format.formatDurationMs(307_000) === "5:07" &&
    format.formatDurationMs(3_723_000) === "1:02:03" &&
    format.formatDurationSeconds(1.5) === "0:01" &&
    format.formatDurationMs(null) === "—" &&
    format.formatBitRate(320_000) === "320 kbps" &&
    format.formatBitRate(1_450_000) === "1.45 Mbps" &&
    format.formatBitRate(0) === "—" &&
    format.formatFrameRate(30000 / 1001) === "29.97 fps" &&
    format.formatFrameRate(30) === "30 fps" &&
    format.formatFrameRate(null) === "—",
);

const ffprobeFixture = JSON.stringify({
  streams: [
    {
      codec_type: "video",
      width: 1920,
      height: 1080,
      codec_name: "h264",
      avg_frame_rate: "30000/1001",
      bit_rate: "1450000",
    },
    { codec_type: "audio", codec_name: "aac" },
  ],
  format: { duration: "12.345", bit_rate: "1500000", format_name: "mov,mp4" },
});
const ffprobeFacts = metadataInfo.parseMediaInfo(ffprobeFixture);
check(
  "ffprobe 原始 JSON → 尺寸/时长/编码/码率/帧率（键名与 `crates/hp-media/src/probe.rs` 一致）",
  ffprobeFacts?.width === 1920 &&
    ffprobeFacts?.height === 1080 &&
    ffprobeFacts?.durationMs === 12345 &&
    ffprobeFacts?.codec === "h264" &&
    ffprobeFacts?.bitRate === 1500000 &&
    Math.abs((ffprobeFacts?.frameRate ?? 0) - 30000 / 1001) < 1e-6,
  JSON.stringify(ffprobeFacts),
);
check(
  "ffprobe 缺项按「有就显示」降级：只有 format.duration 也能取时长，坏 JSON 返回 null",
  metadataInfo.parseMediaInfo('{"format":{"duration":"1.5"}}')?.durationMs === 1500 &&
    metadataInfo.parseMediaInfo('{"format":{"duration":"1.5"}}')?.width === null &&
    metadataInfo.parseMediaInfo('{"format":{"duration":"1.5"}}')?.frameRate === null &&
    metadataInfo.parseMediaInfo("not json") === null &&
    metadataInfo.parseMediaInfo(null) === null,
);
check(
  "EXIF 摘要 JSON → 像素尺寸（PNG 等全 null 不抛错；坏 JSON 返回 null）",
  metadataInfo.parseExifSummary('{"width":4000,"height":3000}')?.width === 4000 &&
    metadataInfo.parseExifSummary('{"width":4000,"height":3000}')?.height === 3000 &&
    metadataInfo.parseExifSummary('{"make":null,"width":null,"height":null}')?.width === null &&
    metadataInfo.parseExifSummary("") === null,
);

// ==================== 元数据面板：结构化明细（2026-11-08 / D145）====================
//
// 防三件事：①解析来源里**不存在**的键（EXIF 只有 exif.rs 产出的六个键，媒体信息是
// ffprobe 完整输出——多解析一个不存在的键就是永远 null 的假字段）；②格式化函数
// 悄悄换口径（EXIF 日期经 Date 猜时区、方向标签不翻译、容器别名不收敛）；③面板把
// 原始 JSON 又摊回主视图（底账必须折叠、结构化表必须在前、缺值必须显示 —）。

const exifFullFixture = JSON.stringify({
  make: "Canon",
  model: "EOS R5",
  dateTime: "2026:11:08 10:20:30",
  orientation: 6,
  width: 8192,
  height: 5464,
  exposureTime: "1/200",
  fNumber: 2.8,
  iso: 400,
  focalLength: 50,
});
check(
  "EXIF 解析键集合与 exif.rs 产出逐一对应（十键，含拍摄参数四项；不解析来源没有的键）",
  (() => {
    const facts = metadataInfo.parseExifSummary(exifFullFixture);
    return (
      facts?.make === "Canon" &&
      facts?.model === "EOS R5" &&
      facts?.dateTime === "2026:11:08 10:20:30" &&
      facts?.orientation === 6 &&
      facts?.width === 8192 &&
      facts?.height === 5464 &&
      facts?.exposureTime === "1/200" &&
      facts?.fNumber === 2.8 &&
      facts?.iso === 400 &&
      facts?.focalLength === 50 &&
      Object.keys(facts ?? {}).length === 10 &&
      // 来源没有的键不解析：塞进去也必须是 undefined，而不是"看起来有值"。
      metadataInfo.parseExifSummary('{"lensModel":"RF 50mm"}')?.lensModel === undefined &&
      // 旧库 / 无 EXIF：拍摄参数四项缺省全 null（前端据此"无就不显示"）。
      (() => {
        const empty = metadataInfo.parseExifSummary('{"make":null,"width":null}');
        return (
          empty?.exposureTime === null &&
          empty?.fNumber === null &&
          empty?.iso === null &&
          empty?.focalLength === null
        );
      })()
    );
  })(),
);
check(
  "拍摄参数格式化：焦距 50 mm / 光圈 f/2.8 / 快门 1/200 与 0.5→1/2 与 2→2 s / ISO 400；无值 null",
  metadataFormat.formatFocalLength(50) === "50 mm" &&
    metadataFormat.formatFocalLength(70.5) === "70.5 mm" &&
    metadataFormat.formatFocalLength(null) === null &&
    metadataFormat.formatFocalLength(0) === null &&
    metadataFormat.formatAperture(2.8) === "f/2.8" &&
    metadataFormat.formatAperture(1.8) === "f/1.8" &&
    metadataFormat.formatAperture(null) === null &&
    metadataFormat.formatExposureTime("1/200") === "1/200" &&
    metadataFormat.formatExposureTime("0.5") === "1/2" &&
    metadataFormat.formatExposureTime("2") === "2 s" &&
    metadataFormat.formatExposureTime("1.3") === "1.3 s" &&
    metadataFormat.formatExposureTime(null) === null &&
    metadataFormat.formatExposureTime("") === null &&
    metadataFormat.formatIso(400) === "ISO 400" &&
    metadataFormat.formatIso(null) === null,
);
check(
  "拍摄参数行 = 自动模式（有就显示、无就不显示；顺序焦距→光圈→快门→ISO；全 null 零行）",
  (() => {
    const full = metadataFormat.buildShootingRows(
      metaT,
      metadataInfo.parseExifSummary(exifFullFixture),
    );
    const partial = metadataFormat.buildShootingRows(
      metaT,
      metadataInfo.parseExifSummary('{"fNumber":1.8,"iso":100}'),
    );
    const none = metadataFormat.buildShootingRows(
      metaT,
      metadataInfo.parseExifSummary('{"make":"Canon"}'),
    );
    return (
      full.length === 4 &&
      full[0].label === "焦距" &&
      full[0].value === "50 mm" &&
      full[1].value === "f/2.8" &&
      full[2].value === "1/200" &&
      full[3].value === "ISO 400" &&
      // 只有光圈与 ISO：只出这两行，焦距/快门不占行（不显示 —）。
      partial.length === 2 &&
      partial[0].value === "f/1.8" &&
      partial[1].value === "ISO 100" &&
      none.length === 0 &&
      metadataFormat.buildShootingRows(metaT, null).length === 0
    );
  })(),
);
check(
  "拍摄参数四个 i18n 键三语齐备，且面板把它们消费进第一段（图像专属、buildShootingRows）",
  ["zh-CN", "zh-TW", "en"].every((lang) => {
    const t = i18nIndex.makeTranslator(lang);
    return ["metadata.focalLength", "metadata.aperture", "metadata.exposureTime", "metadata.iso"].every(
      (k) => t(k) !== k && t(k).length > 0,
    );
  }) &&
    /if \(isImage\) \{\s*out\.push\(\.\.\.buildShootingRows\(app\.t, exifFacts\)\)/.test(
      metadataPanelCode,
    ),
);
check(
  "EXIF 日期按宿主格式重排（不经 Date 猜时区；不匹配原样返回；空值 —）",
  metadataFormat.formatExifDateTime("2026:11:08 10:20:30", "iso", false) === "2026-11-08" &&
    metadataFormat.formatExifDateTime("2026:11:08 10:20:30", "us", false) === "11/08/2026" &&
    metadataFormat.formatExifDateTime("2026:11:08 10:20:30", "eu", true) === "08/11/2026 10:20:30" &&
    metadataFormat.formatExifDateTime("2026:11:08", "iso", true) === "2026-11-08" &&
    metadataFormat.formatExifDateTime("2026:11:08 10:20", "iso", true) === "2026-11-08 10:20:00" &&
    metadataFormat.formatExifDateTime("not a date", "iso", false) === "not a date" &&
    metadataFormat.formatExifDateTime(null, "iso", false) === "—",
);
check(
  "EXIF 方向 1–8 → 翻译键（越界/缺失 null），三语都能翻出非键名文本",
  metadataFormat.exifOrientationKey(1) === "metadata.orientation.1" &&
    metadataFormat.exifOrientationKey(8) === "metadata.orientation.8" &&
    metadataFormat.exifOrientationKey(0) === null &&
    metadataFormat.exifOrientationKey(9) === null &&
    metadataFormat.exifOrientationKey(1.5) === null &&
    metadataFormat.exifOrientationKey(null) === null &&
    ["zh-CN", "zh-TW", "en"].every((lang) => {
      const t = i18nIndex.makeTranslator(lang);
      return [1, 2, 3, 4, 5, 6, 7, 8].every((n) => {
        const text = t(`metadata.orientation.${n}`);
        return text !== `metadata.orientation.${n}` && text.length > 0;
      });
    }),
);
check(
  "容器格式取首个别名（mov,mp4,… → mov）；空值 —",
  metadataFormat.containerFormatLabel("mov,mp4,m4a,3gp,3g2,mj2") === "mov" &&
    metadataFormat.containerFormatLabel("matroska,webm") === "matroska" &&
    metadataFormat.containerFormatLabel("mp3") === "mp3" &&
    metadataFormat.containerFormatLabel(null) === "—" &&
    metadataFormat.containerFormatLabel("  ") === "—",
);
check(
  "ffprobe 扩展字段：profile/pix_fmt/color_space/流级码率/语言/声道（字符串数字都收）",
  (() => {
    const facts = metadataInfo.parseMediaInfo(
      JSON.stringify({
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            profile: "High",
            width: 1920,
            height: 1080,
            pix_fmt: "yuv420p",
            color_space: "bt709",
            avg_frame_rate: "25/1",
            bit_rate: "8000000",
            tags: { language: "und" },
          },
          {
            codec_type: "audio",
            codec_name: "aac",
            profile: "LC",
            sample_rate: "48000",
            channels: 6,
            channel_layout: "5.1",
            bit_rate: "384000",
            tags: { language: "jpn" },
          },
          { codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng" } },
        ],
        format: { duration: "60.0", bit_rate: "8500000", format_name: "matroska,webm" },
      }),
    );
    const [v, a, s] = facts?.streams ?? [];
    return (
      facts?.formatName === "matroska,webm" &&
      facts?.streams?.length === 3 &&
      v?.profile === "High" &&
      v?.pixFmt === "yuv420p" &&
      v?.colorSpace === "bt709" &&
      v?.frameRate === 25 &&
      a?.sampleRate === 48000 &&
      a?.channels === 6 &&
      a?.channelLayout === "5.1" &&
      a?.bitRate === 384000 &&
      a?.language === "jpn" &&
      s?.codecType === "subtitle" &&
      s?.language === "eng"
    );
  })(),
);
check(
  "流级时长兜底：format.duration 缺失时取视频流 duration（秒 → 毫秒）",
  metadataInfo.parseMediaInfo(
    '{"streams":[{"codec_type":"video","duration":"2.5"}]}',
  )?.durationMs === 2500 &&
    metadataInfo.parseMediaInfo('{"streams":[{"codec_type":"audio","duration":"1.25"}]}')?.durationMs ===
      1250,
);
check(
  "媒体明细行：容器/时长在前、逐流分组、und 不显示、缺值 —（行为断言）",
  (() => {
    const facts = metadataInfo.parseMediaInfo(ffprobeFixture);
    const rows = metadataFormat.buildMediaRows(metaT, facts);
    const byLabel = (label) => rows.filter((r) => r.label === label).map((r) => r.value);
    return (
      rows[0]?.label === "容器格式" &&
      rows[0]?.value === "mov" &&
      rows[1]?.label === "时长" &&
      rows[1]?.value === "0:12" &&
      rows.some((r) => r.label === "#1" && r.value === "视频流") &&
      rows.some((r) => r.label === "#2" && r.value === "音频流") &&
      byLabel("编码")[0] === "h264" &&
      byLabel("编码")[1] === "aac" &&
      // fixture 没有像素格式/语言字段：不得出现这些行（有值才显示）。
      !rows.some((r) => r.label === "像素格式") &&
      !rows.some((r) => r.label === "语言") &&
      // 无缓存 → 空数组（面板显示空态，不是假装有行）。
      metadataFormat.buildMediaRows(metaT, null).length === 0
    );
  })(),
);
check(
  "EXIF 明细行：四行固定渲染、全 null 也显示 —（没有 EXIF ≠ 面板坏了）",
  (() => {
    const rows = metadataFormat.buildExifRows(
      metaT,
      metadataInfo.parseExifSummary(exifFullFixture),
      "iso",
      true,
    );
    const empty = metadataFormat.buildExifRows(
      metaT,
      metadataInfo.parseExifSummary('{"make":null,"model":null,"dateTime":null,"orientation":null,"width":null,"height":null}'),
      "iso",
      false,
    );
    return (
      rows.length === 4 &&
      rows[0]?.value === "Canon" &&
      rows[1]?.value === "EOS R5" &&
      rows[2]?.value === "2026-11-08 10:20:30" &&
      rows[3]?.value === "顺时针旋转 90°" &&
      empty.length === 4 &&
      empty.every((r) => r.value === "—") &&
      metadataFormat.buildExifRows(metaT, null, "iso", false).length === 0
    );
  })(),
);
check(
  "声道行：数量 + 布局原文（2 声道 (stereo)）；缺布局只给数量；缺值 —",
  (() => {
    const mk = (channels, layout) =>
      metadataFormat.buildStreamRows(
        metaT,
        {
          codecType: "audio",
          codecName: "aac",
          profile: null,
          width: null,
          height: null,
          durationMs: null,
          frameRate: null,
          pixFmt: null,
          colorSpace: null,
          sampleRate: 48000,
          channels,
          channelLayout: layout,
          bitRate: null,
          language: null,
        },
        0,
      );
    const withLayout = mk(2, "stereo").find((r) => r.label === "声道")?.value;
    const noLayout = mk(1, null).find((r) => r.label === "声道")?.value;
    const missing = mk(null, null).find((r) => r.label === "声道")?.value;
    return withLayout === "2 声道 (stereo)" && noLayout === "1 声道" && missing === "—";
  })(),
);
check(
  "元数据明细区新 i18n 键三语齐备（键存在且非空；方向 8 键已由行为断言覆盖）",
  (() => {
    const keys = [
      "metadata.rawJson",
      "metadata.noData",
      "metadata.container",
      "metadata.profile",
      "metadata.pixFmt",
      "metadata.colorSpace",
      "metadata.channels",
      "metadata.channelsValue",
      "metadata.language",
      "metadata.stream.video",
      "metadata.stream.audio",
      "metadata.stream.subtitle",
      "metadata.cameraMake",
      "metadata.cameraModel",
      "metadata.dateTaken",
      "metadata.orientation",
    ];
    return ["zh-CN", "zh-TW", "en"].every((lang) => {
      const t = i18nIndex.makeTranslator(lang);
      return keys.every((k) => t(k) !== k && t(k).length > 0);
    });
  })(),
);
check(
  "面板三段式：结构化表在前、原始 JSON 收进默认折叠的 details、切文件重置折叠态",
  /<details className="meta-raw">/.test(metadataPanelCode) &&
    !/<details[^>]*\bopen\b/.test(metadataPanelCode) &&
    /<summary>\{t\("metadata\.rawJson"\)\}<\/summary>/.test(metadataPanelCode) &&
    // 结构化表渲染在 details 之前（源码顺序即视觉顺序）。
    metadataPanelCode.indexOf("<MetaRows rows={rows} />") <
      metadataPanelCode.indexOf('<details className="meta-raw">') &&
    /key=\{`exif:\$\{fileKey\}`\}/.test(metadataPanelCode) &&
    /key=\{`media:\$\{fileKey\}`\}/.test(metadataPanelCode) &&
    // EXIF 只给图像、媒体信息只给视频/音频（不再对每个文件摊两堵 JSON 墙）。
    /\{isImage && \(/.test(metadataPanelCode) &&
    /media_type === "video" \|\| meta\?\.media_type === "audio"/.test(metadataPanelCode),
);
check(
  "元数据样式作用域化：共享 .kv/.json-block 缺省值不被面板改动（回归锚点）",
  (() => {
    const css = readFileSync(join(ROOT, "apps/desktop/src/app_ui/shared/styles.css"), "utf8");
    return (
      /\.kv \{\s*display: grid;\s*grid-template-columns: 90px 1fr;\s*gap: 4px 10px;\s*font-size: 12px;/.test(css) &&
      /\.metadata-panel \.meta-kv \{/.test(css) &&
      /\.meta-raw > summary \{/.test(css)
    );
  })(),
);

// 「文件后缀」是**纯解析**（取索引里既有的 `relative_path`，不改后端）：断言它的取值规则，
// 再断言面板**真的**把它渲染在「类型」下面——**位置本身也是需求的一部分**，不能只断言"有这一行"。
check(
  "文件后缀：小写带点（`.png`），只认最后一个点之后的非空片段，认不出返回空串",
  metadataInfo.fileSuffix("photo.JPG") === ".jpg" &&
    metadataInfo.fileSuffix("dir/cover.PNG") === ".png" &&
    metadataInfo.fileSuffix("clip.jpeg") === ".jpeg" &&
    metadataInfo.fileSuffix("dir.v2/cover") === "" &&
    metadataInfo.fileSuffix("noext") === "" &&
    // 隐藏文件（点在首位）与结尾的点都不是后缀。
    metadataInfo.fileSuffix(".gitignore") === "" &&
    metadataInfo.fileSuffix("trailing.") === "" &&
    metadataInfo.fileSuffix("dir\\win\\a.TXT") === ".txt",
);
check(
  "元数据面板在「类型」下面渲染「文件后缀」（无后缀显示 `—`）",
  /fileSuffix\(meta\.relative_path\) \|\| "—"/.test(metadataPanelCode) &&
    /label: app\.t\("metadata\.type"\), value: meta\.media_type \},\s*\{ label: app\.t\("metadata\.extension"\)/.test(
      metadataPanelCode,
    ),
);

check(
  "元数据面板消费三项宿主设置（体积按单位制、日期按格式 + 时间开关）",
  /useHostSettingValue\(SETTING_KEYS\.sizeUnit/.test(metadataPanelSrc) &&
    /useHostSettingValue\(SETTING_KEYS\.dateFormat/.test(metadataPanelSrc) &&
    /useHostSettingValue\(SETTING_KEYS\.dateShowTime/.test(metadataPanelSrc) &&
    /formatByteSize\(meta\.size, sizeUnit\)/.test(metadataPanelSrc) &&
    /formatDateValue\(meta\.mtime, dateFormat, dateShowTime\)/.test(metadataPanelSrc),
);
check(
  "元数据面板按类型自适应：图像解码取像素、视频五项各占一行、音频读一次时长",
  /media_type === "image"/.test(metadataPanelSrc) &&
    /new Image\(\)/.test(metadataPanelSrc) &&
    /isImage\s*\?\s*formatPixelSize\(probed\.width \?\? exifFacts\?\.width/.test(metadataPanelSrc) &&
    /formatPixelSize\(mediaFacts\?\.width \?\? probed\.width/.test(metadataPanelSrc) &&
    /new Audio\(\)/.test(metadataPanelSrc) &&
    /preload = "metadata"/.test(metadataPanelSrc) &&
    /parseMediaInfo\(meta\?\.media_info_json\)/.test(metadataPanelSrc) &&
    /metadata\.dimensions/.test(metadataPanelSrc) &&
    /metadata\.duration/.test(metadataPanelSrc) &&
    /metadata\.codec/.test(metadataPanelSrc) &&
    /metadata\.bitrate/.test(metadataPanelSrc) &&
    /metadata\.frameRate/.test(metadataPanelSrc),
);
// 视频的 DOM 兜底：索引里的 `media_info_json` 只在扫描时 ffprobe 可用才写入，
// 早于该状态的索引行永远是空的（库内实测存在），只靠缓存会"什么都不显示"。
check(
  "视频有 DOM 兜底：索引无 ffprobe 缓存时用 `<video>` 探尺寸与时长，且缓存优先",
  /document\.createElement\("video"\)/.test(metadataPanelSrc) &&
    /video\.videoWidth/.test(metadataPanelSrc) &&
    /video\.videoHeight/.test(metadataPanelSrc) &&
    /mediaFacts\?\.width \?\? probed\.width/.test(metadataPanelSrc) &&
    /mediaFacts\?\.durationMs \?\? probed\.durationMs/.test(metadataPanelSrc),
);
// 取不到值的类型行**仍然渲染**（显示 `—`）：否则"索引里没数据"与"面板坏了"外观完全一样，
// 用户无法区分——这正是本轮实测踩到的那次。
check(
  "类型相关的行不因取不到值而消失（缺值显示 `—`，不是静默省略）",
  /mediaFacts\?\.codec \?\? "—"/.test(metadataPanelSrc) &&
    /formatBitRate\(mediaFacts\?\.bitRate\)/.test(metadataPanelSrc) &&
    /label: app\.t\("metadata\.duration"\)/.test(metadataPanelSrc) &&
    !/if \(dimensions !== "—"\)/.test(metadataPanelSrc) &&
    !/if \(duration !== "—"\)/.test(metadataPanelSrc),
);
// 图像查看器信息栏与元数据面板同口径：体积/日期走宿主设置，宽高比/百万像素/缩放仍归它自己。
// 防的是"信息栏又自带一套 1024 进制却标 KB 的旧口径"。
const viewerFormatSrc = readFileSync(
  join(ROOT, "apps/desktop/src/app_ui/panels/imageviewer/viewerFormat.ts"),
  "utf8",
);
check(
  "图像查看器信息栏的体积/日期改用宿主设置与共享格式化（不再自带旧口径）",
  format.formatByteSize(1024, "binary") === "1.00 KiB" &&
    /formatByteSize\(totalBytes, sizeUnit\)/.test(viewerInfoBarSrc) &&
    /formatByteSize\(file\.size, sizeUnit\)/.test(viewerInfoBarSrc) &&
    /formatDateValue\(file\.mtime, dateFormat, dateShowTime\)/.test(viewerInfoBarSrc) &&
    /formatPixelSize\(natural\?\.width/.test(viewerInfoBarSrc) &&
    /resolveSizeUnit\(useHostSettingValue\(SETTING_KEYS\.sizeUnit/.test(imageViewerPanelSrc) &&
    /sizeUnit=\{sizeUnit\}/.test(imageViewerPanelSrc) &&
    // 旧实现必须真的删掉：留着就还能被再次接上（`KB` 错标的来源）。
    !/formatBytes/.test(viewerFormatSrc) &&
    !/formatDateTime/.test(viewerFormatSrc) &&
    !/formatDimensions/.test(viewerFormatSrc),
);
check(
  "元数据面板拿到 dockview 面板 API（宿主设置热加载第 4 条触发源）",
  /^ {2}metadata: \(ctx\) => <MetadataPanel api=\{ctx\.api\} \/>,$/m.test(
    registrySource,
  ),
);
check(
  "元数据面板**不自带面板设置**（体积/日期是全仓库共用的宿主项，避免两套口径）",
  (config.panelSpec("metadata")?.settings ?? []).length === 0,
);

}
