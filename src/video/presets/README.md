# 视觉 Preset 系统

一个 preset = 一组 `video_*` 配置的批量覆盖,通过 CLI `--preset` 注入,本次运行生效,**不写入数据库**。

## 生效机制

1. `echocut burn <file> --preset=douyin` 读 `douyin.json` 的 `config` 字段
2. `src/cli/commands/burn.js` 把 config 对象 JSON 字符串化,设置到子进程环境变量 `ZDE_PRESET_CONFIG`
3. 子进程 `scripts/run-video-cases.js` 的所有 `getConfigValue(key)` 调用,在 `src/db/configRepo.js` 里先查 preset,命中则返回,不命中则 fallthrough 到数据库

优点:
- 一处改动(`configRepo.js`),所有配置读取点(captionConfig.js / remotionRunner.js / processor.js)自动受益
- 不污染 DB,CLI 退出后不影响后台/其他流程
- preset 切换零副作用

## 可覆盖的 key

所有 `DEFAULT_CONFIGS` 里的 key 都可以被覆盖。常用的 video 相关:

| key | 含义 | 默认 | bounds |
|---|---|---|---|
| `video_layout_subtitle_font_size` | 字幕字号(1080p 基准) | 150 | 20-300 |
| `video_layout_headline_font_size` | 顶部大标题字号 | 96 | 28-140 |
| `video_layout_subline_font_size` | 顶部副标题字号 | 54 | 18-88 |
| `video_caption_subtitle_outline` | 字幕描边粗细 | 0 | 0-8 |
| `video_caption_subtitle_shadow` | 字幕阴影 | 3.0 | 0-8 |
| `video_caption_subtitle_color` | 字幕主色 | #F2F4F8 | hex |
| `video_caption_subtitle_outline_color` | 字幕描边色 | #0F172A | hex |
| `video_caption_highlight_color` | 关键词高亮色 | #FFCF40 | hex |
| `video_caption_title_color` | 标题色 | #FFCF40 | hex |
| `video_caption_keywords` | 关键词高亮列表(逗号分隔) | — | — |
| `video_caption_sentence_max_chars` | 单句最大字符数 | 18 | 10-20 |
| `video_caption_chunk_max_chars` | 单 chunk 最大字符数 | 16 | 6-18 |

数值类型会在 `captionConfig.js` 的 `getNumericConfig` 里做二次 bounds 校验,超出范围自动回落到 fallback。

## 现有 preset

- `douyin.json` — 抖音/口播大字幕风格,超大字号 + 强描边 + 黄色关键词

## 后续计划

- `business.json` — 商业稳重风格(中号 + 白字蓝关键词),适合 B2B
- `story.json` — 叙事长视频风格(小号 + 衬线感),适合访谈/直播回放
- 支持 preset 继承(`extends: "douyin"`)
- Admin 后台可视化 preset 编辑器
