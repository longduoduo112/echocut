'use strict';

/**
 * 给每个子命令的 --help 输出末尾追加示例段(commander .addHelpText('after')).
 *
 * 每个命令给 3-5 个典型例子,覆盖"最简用法 + 常用组合 + 高级场景"。
 * 用户敲 `echocut <cmd> --help` 时能直接抄代码跑。
 */

const EXAMPLES = {
    burn: `
示例:
  # 最简:默认品牌 example,竖屏出片
  echocut burn ./input.mp4

  # 金标准:切口水词 + 切静默 + 自定义标题
  echocut burn ./input.mp4 --cut-fillers --cut-silence --headline "AI 时代的生存术"

  # 横屏录屏演示(不盖标题,保留品牌胶囊)
  echocut burn ./demo.mp4 --no-title --cut-fillers

  # 户外风噪降噪(RNNoise 神经网络)
  echocut burn ./outdoor.mp4 --denoise --denoise-mix 0.85

  # 快速预览(只渲染前 30 秒,调试用)
  echocut burn ./input.mp4 --preview 30

  # 换品牌 + 自定义 BGM
  echocut burn ./video.mp4 --brand lisi --bgm 02-guzheng-zen --bgm-volume 0.12

  # 【v0.10+】黄金 3 秒:LLM 自动找最炸一句,复制到片头(提升完播率)
  echocut burn ./video.mp4 --cut-fillers --cut-silence --golden-hook

  # 手动指定钩子起点 + 时长
  echocut burn ./video.mp4 --golden-hook --golden-start 42 --golden-duration 3.5`,

    batch: `
示例:
  # 批量 burn 整个目录
  echocut batch ./videos/ --cut-fillers

  # 批量 highlights(每视频自动切 4 段)
  echocut batch ./videos/ --action highlights --segments 4

  # 递归遍历 + 只处理前 5 个
  echocut batch ./archive/ --recursive --limit 5

  # 换品牌批量出片
  echocut batch ./videos/ --brand lisi --cut-fillers`,

    article: `
示例:
  # 从视频直出文章(会先 ASR 转写)
  echocut article --video-file ./video.mp4

  # 从已有转写 JSON 生成(最快)
  echocut article --transcript-file debug_outputs/video/xxx/transcript.json

  # 从纯文本直接生成
  echocut article --text "我今天想聊..." --mode default

  # 硬核拆解 + 保存到文件
  echocut article --video-file ./v.mp4 --mode hardcore --output ./article.md

  # 走心复盘 + 指定品牌
  echocut article --audio-file ./p.m4a --mode soul --brand lisi

  # 固化品牌 CTA(自动 append 到文章末尾)
  echocut article --video-file ./v.mp4 --cta "每周一 build log · painhunt.dev"`,

    highlights: `
示例(V1 硬指定 N 段,新工作流推荐用 hls/hmk 两阶段):
  # 默认 4 段 + 切口水词
  echocut highlights ./long.mp4 --segments 4 --cut-fillers

  # 竖屏预设 + 跳过确认 + 自定义输出目录
  echocut highlights ./long.mp4 --style-preset vertical --yes --output-dir ./clips/

  # 不生成宣发素材包(只出视频)
  echocut highlights ./long.mp4 --segments 3 --no-publish-kit`,

    'highlights-ls': `
示例:
  # 分析长视频,LLM 识别候选精华(首次 1-3 分钟,之后读缓存秒开)
  echocut hls ./long.mp4

  # 只看高分候选
  echocut hls ./long.mp4 --min-score 0.8

  # 强制重算(忽略缓存)
  echocut hls ./long.mp4 --rerun

  # 换 ASR 引擎
  echocut hls ./long.mp4 --engine funasr`,

    'highlights-make': `
示例:
  # 出最高分那条
  echocut hmk ./long.mp4 --seg 1

  # 出全部候选(会比较久,串行跑)
  echocut hmk ./long.mp4 --all

  # 按评分筛
  echocut hmk ./long.mp4 --min-score 0.8

  # 多个指定 seg
  echocut hmk ./long.mp4 --seg 1,3,5

  # 户外场景 + 降噪 + 自定义 BGM
  echocut hmk ./outdoor.mp4 --all --denoise --bgm 03-lofi-podcast

  # 关闭 filler 切除(保留原样)
  echocut hmk ./long.mp4 --seg 1 --no-cut-fillers --no-cut-silence

  # 【v0.10+】每个 seg 带黄金 3 秒钩子(LLM 在 seg 内部找金句)
  echocut hmk ./long.mp4 --all --golden-hook`,

    'article-from-clip': `
示例:
  # 最高分 seg + auto mode(按 hook_type 自动选)
  echocut afc ./long.mp4

  # 一次出所有 seg 的文章(一个 hls → N 篇)
  echocut afc ./long.mp4 --all

  # 指定 seg + 3 种风格对比
  echocut afc ./long.mp4 --seg 1 --mode default,hardcore,soul

  # 高分筛 + 带品牌 CTA
  echocut afc ./long.mp4 --min-score 0.8 --cta "painhunt.dev 见"

  # 切更强的推理模型(语义更准)
  echocut afc ./long.mp4 --seg 1 --model deepseek-r1:14b

  # 深度自检重写(v0.9+)
  echocut afc ./long.mp4 --seg 1 --deep-review`,

    'hook-gen': `
示例:
  # 从 hls 最高分 seg 出 5 个钩子候选(反常识/挑衅/身份/数字/故事)
  echocut hook-gen ./long.mp4

  # A/B 模式:跑 2 轮共 10 候选,去重取 Top 5(推荐挑爆款时用)
  echocut hook-gen ./long.mp4 --rounds 2

  # 指定 seg
  echocut hook-gen ./long.mp4 --seg 2

  # 从纯文本生成(演讲稿/随笔)
  echocut hook-gen --text "AI 时代每个创业者都该..."

  # 保存到 md 供后续挑选
  echocut hook-gen ./long.mp4 --output hooks.md --rounds 2`,

    distribute: `
示例:
  # 最常用:从 hls 最高分 seg 出六平台分发包(自动带 pillar 标签)
  echocut distribute ./long.mp4

  # 指定 seg(产物和 afc/hmk 同目录)
  echocut distribute ./long.mp4 --seg 2

  # 自定义输出目录
  echocut distribute ./long.mp4 --seg 1 --output-dir ./pack/

  # 从纯文本生成
  echocut distribute --text "我这周的一点思考..."

  # 换品牌 + 大模型
  echocut distribute ./long.mp4 --seg 1 --brand lisi --model deepseek-r1:14b`,

    'cross-lang': `
示例:
  # 中→英 bundle(5 hooks + 5-7 条 Twitter thread + 英文 blog)
  echocut cross-lang ./long.mp4 --seg 1

  # 中→日(v0.9+)
  echocut cross-lang ./long.mp4 --seg 1 --target-lang ja

  # 中→西(v0.9+)
  echocut cross-lang ./long.mp4 --seg 1 --target-lang es

  # 从纯中文文本生成英文 bundle
  echocut cross-lang --text "AI 时代的创业者..."

  # 自定义输出目录
  echocut cross-lang ./long.mp4 --output-dir ./en-pack/`,

    'weekly-retro': `
示例:
  # 生成本周模板(周一早上跑)
  echocut weekly-retro --period "2026-04-14~04-20"

  # 周日填完数据 → LLM 分析爆款 + 下周选题
  echocut weekly-retro --analyze weekly-retros/2026-W16/weekly-retro-example-*.md

  # 换品牌
  echocut weekly-retro --period "2026-04-14~04-20" --brand lisi

  # 模板已存在想覆盖
  echocut weekly-retro --period "2026-04-14~04-20" --force`,

    music: `
示例:
  # 单首 ad-hoc(任意 prompt)
  echocut music --prompt "uplifting acoustic guitar journey" --name my-adventure

  # 跑预设批次(30 首 DJ 精选)
  echocut music --set dj

  # 看有哪些预设
  echocut music --list-sets

  # 预设批次并行(不同终端):先 creator 再 dj
  echocut music --set creator        # 15 首创业正能量
  echocut music --set dj              # 30 首 DJ 精选(世界音乐/电子/影视/融合/好玩)

  # 自定义 JSON 文件批量
  echocut music --file ./my-prompts.json
  # my-prompts.json: [{"name":"test-01","prompt":"..."},{"name":"test-02","prompt":"..."}]

  # 强制重跑(默认已存在跳过)
  echocut music --prompt "..." --name test --overwrite

  # 【v0.11.4+】扫描本地 BGM 库(按 set 分组,带时长/大小/prompt 描述)
  echocut music --list
  echocut music --list --filter handpan        # 只看含 handpan 的
  echocut music --list --filter creator        # 只看 creator- 开头的

  友好错误处理:API key 缺 / 配额不足 / 超时 都有清晰提示`,

    cover: `
示例:
  # 默认:example 品牌 · 竖屏 9:16 封面(抖音/视频号/小红书)
  echocut cover --headline "读书买书,家里要无条件满足" --subline "随处可得 处处进步"

  # 只给主标题(副标留空也可以)
  echocut cover --headline "这本书教会我的"

  # 方图 1:1(公众号头图 / 朋友圈)
  echocut cover --headline "这本书教会我的" --ratio 1:1 --output ./gzh-thumb.jpg

  # 换品牌 + 自定义输出路径
  echocut cover --headline "..." --brand lisi --output ./assets/lisi-cover.jpg

  # 文件已存在 → 强制覆盖
  echocut cover --headline "..." --output ./cover.jpg --force

  用途:你用别的工具(剪映/CapCut/Premiere)剪视频,但想要品牌统一的封面 jpg
  当前只支持 9:16 和 1:1(模板是竖版),横屏 16:9 待 v0.11 加横版模板`,

    brand: `
示例:
  # 列出所有品牌
  echocut brand --list

  # 查看某个品牌详情
  echocut brand --show example
  echocut brand --show example

  # 品牌 7 点资产 checklist(bio/公众号名/视觉/CTA/禁忌/节奏)
  echocut brand --checklist
  echocut brand --checklist lisi`,

    publish: `
示例:
  # 上传成片到 S3/MinIO,返回 7 天签名链接
  echocut publish ./output.mp4

  # 换品牌目录
  echocut publish ./output.mp4 --brand example

  # 查看存储状态
  echocut publish --status

  # 列出 bucket 文件
  echocut publish --list
  echocut publish --list --prefix example/2026-04

  # 清理 7 天前的旧文件
  echocut publish --purge 7`,

    tasks: `
示例:
  # 活跃任务(pending + processing + 最近完成)
  echocut tasks

  # 全部任务
  echocut tasks --all

  # 按用户筛
  echocut tasks --user xiaomei`,

    sync: `
示例:
  # 按时间顺序处理所有 pending
  echocut sync

  # 只处理 #5 这一条
  echocut sync --task-id 5

  # 持续轮询(每 2 分钟检查)
  echocut sync --loop

  # 每 5 分钟检查(低频省电)
  echocut sync --loop 300

  # 加可视化监控面板
  echocut sync --loop --dashboard`,

    doctor: `
示例:
  # 环境自检(Node / FFmpeg / Python / Ollama / 内存)
  echocut doctor

  # 探活 MiniMax API key
  echocut doctor --minimax`,

    studio: `
示例:
  # 启动管理后台(默认 http://localhost:3399)
  echocut studio`,

    ingest: `
示例(v0.11.1+):

  # 批量分析素材目录,本地 minicpm 视觉模型打 tag,产出 _metadata.json
  echocut ingest ./my-clips/

  # 调试时只跑前 3 个
  echocut ingest ./HK-0418-19/ --limit 3

  # 强制重跑(默认有缓存)
  echocut ingest ./my-clips/ --rerun

  # 换模型
  echocut ingest ./my-clips/ --model "openbmb/minicpm-o2.6:latest"

说明:
  · 产出 _metadata.json 放在目录下,vlog-plan / vlog 会读取
  · 缓存 key = mtime + size(素材不变则秒过)`,

    'vlog-plan': `
示例(v0.11.4+ ⭐ AI 写 plan):

  # 最简:主题 + 核心理念 → 3 个候选 plan(JSON)
  echocut vlog-plan \\
    --ingest ./HK-0418-19 \\
    --theme "出差路上的思考" \\
    --idea "专注 · 坚持 · 把问题想小一点"

  # 出 5 个 + 手动指定风格
  echocut vlog-plan --ingest ./my-clips \\
    --theme "创业者的一天" --idea "独立 · 成长" \\
    --count 5 --style startup-journey

  # 目标时长 40 秒 + BGM 偏好
  echocut vlog-plan --ingest ./my-clips \\
    --theme "..." --idea "..." \\
    --duration 40 --bgm "acoustic warm"

  # 指定输出目录(默认 ./vlog-plans/)
  echocut vlog-plan --ingest ./my-clips --theme ... --idea ... \\
    --output-dir /tmp/plans

工作流:
  1. echocut ingest ./my-clips/
  2. echocut vlog-plan --ingest ./my-clips --theme ... --idea ...
  3. 人工挑选最满意的 plan JSON
  4. node scripts/render-vlog-from-plan.js <plan.json> ./my-clips <out.mp4>`,

    vlog: `
示例(v0.11.4+ ⭐ 一步到位,plan + 批量渲染):

  # 最简:3 个候选全都渲染成片(字幕围绕你的核心理念)
  echocut vlog \\
    --ingest ./HK-0418-19 \\
    --theme "出差路上的思考" \\
    --idea "专注 · 坚持 · 把问题想小一点"

  # 出 5 条候选
  echocut vlog --ingest ./my-clips \\
    --theme "..." --idea "..." --count 5

  # 换品牌
  echocut vlog --ingest ./my-clips \\
    --theme "..." --idea "..." --brand lisi

  # 自定义输出目录
  echocut vlog --ingest ./my-clips \\
    --theme "..." --idea "..." \\
    --output-dir ./vlog-output-2026-04-24

使用建议:
  · count 建议 2-5(MiniMax 不掺和 LLM,完全本地跑,快但 plan 多反而不好挑)
  · 挑最满意那条发出去,其余删除 — 这是"AI 先选型你再拍板"的工作流
  · 字幕都围绕你给的 --idea,不是 AI 随便写`,

    minimax: `
示例(需要 .env 里 MINIMAX_API_KEY):

  # 看当前配额状态(官方没开放查询 API,指引到用户中心)
  echocut minimax quota

  # 文生图(默认 image-01,竖屏 9:16)
  echocut minimax image \\
    --prompt "cinematic still of a man writing on a laptop, warm morning light" \\
    --ratio 9:16 --output-dir ./covers --name cover-01

  # 同一 prompt 一次出 3 张
  echocut minimax image --prompt "..." -n 3 --output-dir ./shots

  # TTS 文本转语音(需套餐里开了 speech 模型)
  echocut minimax tts --text "你好,我是Example。" --voice male-qn-qingse --output hello.mp3
  echocut minimax tts --file lines.txt --emotion happy --speed 1.1 --output out.mp3

  # 文生视频(Hailuo 异步,create → poll → 下载,通常 1-3 分钟)
  echocut minimax video --prompt "a cat writing code at dawn" --duration 6 --output cat.mp4

  # 图生视频(带首帧图)
  echocut minimax video --prompt "camera slowly zooms in" \\
    --first-frame ./cover.jpg --duration 6 --output out.mp4

  # music-cover / lyrics:endpoint 已探测但 body spec 未公开,运行时会给出占位提示
  echocut minimax music-cover
  echocut minimax lyrics

注:
  · 独立正交 — 与 burn/highlights/vlog 等其他子命令解耦,未来换供应商只改 minimaxClient。
  · BGM 音乐生成继续走稳定已用的 \`echocut music\`(不并入 minimax)。`
};

/**
 * 把 examples 挂到每个 commander 子命令。commander 的 .addHelpText('after', text)
 * 会在 --help 输出末尾追加一段文本。
 *
 * @param {Command} program commander 根 program
 */
function attachExamplesToCommands(program) {
    for (const cmd of program.commands) {
        // 子命令 name 可能有别名,如 'highlights-ls|hls',取第一段
        const primaryName = cmd.name().split('|')[0];
        // alias lookup
        const key = EXAMPLES[primaryName] ? primaryName :
            (cmd.aliases().map((a) => EXAMPLES[a]).find(Boolean) ? cmd.aliases().find((a) => EXAMPLES[a]) : null);
        const text = EXAMPLES[primaryName] || (key ? EXAMPLES[key] : null);
        if (text) cmd.addHelpText('after', text);
    }
}

module.exports = { EXAMPLES, attachExamplesToCommands };
