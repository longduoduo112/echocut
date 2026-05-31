# Brand 配置目录

这是多用户品牌配置的存放地。每一个 `<id>.json` 文件就是一个独立创作者的"数字分身"。

## 结构

```
configs/brands/
├── _README.md              ← 本文件
├── _template.json          ← 新用户从这里复制开始
├── example.json             ← Example的完整配置(当前默认)
├── example/
│   └── cover-template.png  ← Example的封面模板图
├── zhangsan.json           ← 未来:张三
└── zhangsan/
    └── cover-template.png  ← 张三的封面模板图
```

## 创建一个新品牌

1. `cp _template.json <your-id>.json`
2. 把 `_template.json` 里的占位符全部替换成你自己的
3. 建目录 `mkdir <your-id>` 把你的封面模板 PNG 放进去(规格见下)
4. 用 `echocut brand --list` 确认加载成功
5. 用 `echocut burn <video> --brand <your-id>` 试跑一条

## 字段速查

| 字段 | 用途 | 位置 |
|---|---|---|
| `id` | 内部 ID,CLI 用 `--brand <id>` 引用 | - |
| `displayName` | 人类可读名称,终端日志展示 | - |
| `identity.name` | 主名称,出现在 video metadata/文章 prompt 里 | LLM |
| `identity.realName` | 真名,可选,给 LLM 理解用 | LLM |
| `identity.title` | 头衔/职位 | LLM |
| `identity.slogan` | 一句话 slogan | LLM + CTA |
| `identity.description` | 50-100 字人物画像,注入到 `personaBase` | LLM |
| `visual.brandTag` | 顶部/CTA 品牌胶囊文字(如 `@example`) | 视觉 |
| `visual.tagBgColor` | 胶囊底色,#RRGGBB | 视觉 |
| `visual.tagTextColor` | 胶囊字色,#RRGGBB | 视觉 |
| `visual.coverTemplate` | 封面背景 PNG 相对路径 | 视觉 |
| `cta.title/subtitle/hint` | 尾卡 CTA 三行文字 | 视觉 |
| `bgm.defaultName` | 默认 BGM 文件名(`assets/bgm/` 下) | 音频 |
| `bgm.defaultVolume` | 默认 BGM 音量 0-1 | 音频 |
| `llm.personaBase` | 人格基线,其他所有 prompt 可用 `{{personaBase}}` 嵌入 | LLM |
| `llm.articleModes.{default,hardcore,soul,nomad}.system` | 4 种文章风格的完整 system prompt | LLM |
| `llm.momentsPrompt` | 朋友圈文案 prompt | LLM |
| `llm.videoMetadataPrompt` | 视频标题策划 prompt | LLM |
| `llm.videoMetadataPersona` | 视频标题策划的人格 system | LLM |
| `llm.captionEmphasisPrompt` | 字幕爆点词发现 prompt | LLM |
| `llm.videoPublishPrompt` | 视频宣发素材包 prompt(4 组标题+简介) | LLM |
| `llm.xiaohongshuPrompt` | 小红书图文笔记 prompt | LLM |
| `llm.douyinPrompt` | 抖音/视频号描述 prompt | LLM |
| `asrDomainKeywords` | ASR 专词表(数组),帮转写识别你常用的术语 | ASR |
| `typoFixes` | 错别字矫正(如"大标"→"Example") | ASR |

## 占位符自动插值

所有 `llm.*` 字段里的这些占位符会自动被替换:

| 占位符 | 替换为 |
|---|---|
| `{{name}}` | `identity.name` |
| `{{realName}}` | `identity.realName` |
| `{{title}}` | `identity.title` |
| `{{slogan}}` | `identity.slogan` |
| `{{description}}` | `identity.description` |
| `{{personaBase}}` | `llm.personaBase` (二轮插值) |

这意味着你可以在一个地方改 `identity.name`,所有 prompt 都跟着变。

## 封面模板图规格

- **尺寸**: 至少 2000 × 1500 px(越大越好,裁剪用)
- **格式**: PNG(带透明通道更好)
- **构图**: 人物居中偏上,胸前以下区域会被黑条覆盖,标题会打在胸前黑条上
- **底色**: 室内/自然环境都可以,不要花哨背景
- **避开**: 人脸别靠右(右侧封面会被竖屏裁掉)

Example的 `example/cover-template.png` 就是一个好范例,可以对照着拍。

## 注意事项

- **`_` 开头的文件会被 brand loader 忽略**(当作模板/说明,不是真品牌)
- **asrDomainKeywords 是完整替换,不合并**,所以别漏写常用词
- **改了 brand.json 后不需要重启,下次跑 CLI 就生效**
- **两个 brand 可以同时存在,互不干扰**,用 `--brand` 切换

## SaaS fallback:`_default` 中性品牌

`example.com` 上有些用户不会主动配置品牌,直接传视频上来。这种情况 sync.js **绝不**退化到 example(那是 Bill 自己的形象,会污染他人视频),而是用 `_default` 中性模板:

- `_default.json` — 字段全部中性,封面用 echocut 平台视觉(暗夜星河 + "echocut·回声 · 帮你高效创作自媒体" 顶标 + example.com 尾标)
- `_default/cover-template.png` — 1080×1920 中性封面底图(不含任何人形象)
- `sync.js` 加载 `_default` 后,**运行时把 `username` 注入** `identity.name` / `visual.brandTag`,生成 `_user_<username>.json` 临时实例
  - 比如 Jay 上传时 → `_user_Jay.json`,brandTag = `@Jay`,封面是平台中性视觉
- `_user_*.json` 在 `.gitignore` 里,不入库

**重要**:CLI 直接 `echocut burn` 不会走到 `_default`,默认还是 `example`,Bill 自己跑数据时不变。中性 fallback 只对 `echocut sync` 链路生效。
