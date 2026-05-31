#!/usr/bin/env node
/**
 * generate-bgm.js — 用 MiniMax music-2.6 生成 BGM 素材库
 *
 * 跑 8 首不同风格的 instrumental BGM,全部存到 assets/bgm/
 * 需要 .env 里 MINIMAX_API_KEY
 *
 * 用法:
 *   node scripts/generate-bgm.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const API_KEY = process.env.MINIMAX_API_KEY;
const API_BASE = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com';
const API_URL = `${API_BASE}/v1/music_generation`;
const OUT_DIR = path.resolve(__dirname, '..', 'assets', 'bgm');

// ─── 第一批: 8 首风格各异的背景音 ─────────────────────────
const BACKGROUND_PROMPTS = [
    { name: '01-piano-calm',     prompt: 'soft solo piano, slow mellow, peaceful, low volume background music for business podcast, contemplative, minimal' },
    { name: '02-guzheng-zen',    prompt: '中国古风古筝钢琴纯音乐,宁静致远,舒缓悠远,禅意,适合商业口播背景' },
    { name: '03-lofi-podcast',   prompt: 'lo-fi hip-hop instrumental, mellow jazz piano, rainy cafe, slow tempo, perfect for podcast background' },
    { name: '04-strings-mellow', prompt: 'classical string quartet, cello and violin, slow andante, contemplative, baroque chamber music, background' },
    { name: '05-jazz-piano',     prompt: 'smooth jazz piano trio, slow tempo, late night cafe, introspective, minimal bass and brushed drums' },
    { name: '06-ambient',        prompt: 'ambient electronic pad, deep space, meditation, minimalist, slow evolving texture, background drone' },
    { name: '07-newage',         prompt: 'new age meditation music, piano and flute, flowing calm, nature inspired, background zen' },
    { name: '08-bossa-light',    prompt: 'light bossa nova, soft acoustic guitar and brush drums, Brazilian cafe, slow tempo, relaxed background' }
];

// ─── 第二批: 20 首优雅的单乐器独奏 ─────────────────────────
const SOLO_PROMPTS = [
    // 陶笛 3 首(用户特别指定)
    { name: 'solo-01-ocarina-mountain',    prompt: '陶笛独奏,悠远空灵,山间雾气弥漫,慢节奏,带着古风禅意,中国传统乐器' },
    { name: 'solo-02-ocarina-cinematic',   prompt: 'epic ocarina solo, cinematic emotional melody, slow tempo, like Zelda Song of Storms, haunting and memorable' },
    { name: 'solo-03-ocarina-zen',         prompt: 'Asian ceramic ocarina solo, zen meditation, breathy and airy, slow contemplative, minimal reverb' },
    // 奇异恩典 3 首(不同乐器)
    { name: 'solo-04-amazing-grace-piano',  prompt: 'Amazing Grace hymn, solo piano arrangement, slow spiritual, emotional, classic church version' },
    { name: 'solo-05-amazing-grace-violin', prompt: 'Amazing Grace, solo violin, sacred slow tempo, like Joshua Bell, churchlike reverence' },
    { name: 'solo-06-amazing-grace-guitar', prompt: 'Amazing Grace, solo fingerstyle acoustic guitar, peaceful spiritual, Tommy Emmanuel style' },
    // 爱尔兰/苏格兰风笛 2 首
    { name: 'solo-07-uilleann-celtic',     prompt: 'Irish uilleann pipes solo, mournful celtic melody, traditional ballad, slow and soulful, bagpipes' },
    { name: 'solo-08-bagpipes-highland',   prompt: 'Scottish highland bagpipes solo, majestic slow movement, mountain winds, solemn dignity' },
    // 中国民乐 5 首
    { name: 'solo-09-erhu-jiangnan',       prompt: '二胡独奏,江南水乡,深情婉转,慢板,抒情古风,像赛马前的宁静' },
    { name: 'solo-10-bamboo-flute',        prompt: '中国竹笛独奏,清幽悠远,月夜竹林,传统民乐,呼吸感强' },
    { name: 'solo-11-guzheng-flowing',     prompt: '古筝独奏,高山流水,春江花月夜风格,琴弦清脆,悠长' },
    { name: 'solo-12-pipa-tang',           prompt: '琵琶独奏,古典唐风,叙事性旋律,像十面埋伏的慢板' },
    { name: 'solo-13-xiao-meditation',     prompt: '洞箫独奏,禅意深远,高山空谷,气息悠长,古风禅意' },
    // 西洋古典独奏 3 首
    { name: 'solo-14-violin-baroque',      prompt: 'solo violin, baroque style slow movement, Bach Partita inspired, contemplative, unaccompanied' },
    { name: 'solo-15-cello-melancholy',    prompt: 'solo cello, melancholic slow andante, deep and reflective, like Bach Cello Suites' },
    { name: 'solo-16-piano-einaudi',       prompt: 'solo piano neoclassical, like Ludovico Einaudi or Yiruma, slow emotional, simple melody' },
    // 世界音乐独奏 4 首
    { name: 'solo-17-shakuhachi-zen',      prompt: 'Japanese shakuhachi bamboo flute solo, zen meditation, slow and breathy, monastery' },
    { name: 'solo-18-handpan-healing',     prompt: 'hang drum handpan solo, healing peaceful tones, slow meditation, steel tongue drum' },
    { name: 'solo-19-fingerstyle-guitar',  prompt: 'solo acoustic fingerstyle guitar, introspective, like Andy McKee or Sungha Jung, slow' },
    { name: 'solo-20-harmonica-blues',     prompt: 'solo harmonica, slow blues, late night reflection, soulful, minimal' }
];

// ─── Retry 批次: 第二批失败的 5 首,稍微调整 prompt 提高成功率 ─
const RETRY_PROMPTS = [
    { name: 'solo-03-ocarina-zen',        prompt: 'Asian ocarina ceramic flute solo, slow zen meditation, traditional Chinese, breathy airy tone' },
    { name: 'solo-07-uilleann-celtic',    prompt: 'Celtic Irish uilleann pipes solo, mournful traditional, slow ballad, emerald isle' },
    { name: 'solo-11-guzheng-flowing',    prompt: 'Chinese guzheng solo, flowing water melody, classical zither, slow plucked strings' },
    { name: 'solo-14-violin-baroque',     prompt: 'solo violin baroque, slow sarabande, contemplative unaccompanied, Bach inspired' },
    { name: 'solo-19-fingerstyle-guitar', prompt: 'solo fingerstyle acoustic guitar, slow introspective melody, Andy McKee style' }
];

// ─── 第三批: 15 首创业/成长/正能量调性(example 品牌基调)─────────────────
// 用户反馈 v0.11.1:核心调性是创业/奋斗/成长/正能量,避开悲伤孤独
// 出差、演讲、客户现场、路上奋斗、旅行游寄(正能量版) 都要能配
const CREATOR_VIBES_PROMPTS = [
    // 创业/build in public (5 首)
    { name: 'creator-01-lofi-buildinpublic', prompt: 'modern upbeat lo-fi instrumental, subtle drum groove, warm synth pads, for indie hacker build-in-public video, focused and hopeful' },
    { name: 'creator-02-electronic-focus',   prompt: 'chill electronic instrumental, mid-tempo house, warm analog synths, for coding and startup vlog, motivating but not distracting' },
    { name: 'creator-03-piano-drive',        prompt: 'uplifting piano driven instrumental with light drum beat, progressive build, for startup journey video, determined and hopeful' },
    { name: 'creator-04-synth-journey',      prompt: 'cinematic synthwave slow build, retro 80s analog synth, for entrepreneur journey vlog, hopeful and expansive' },
    { name: 'creator-05-acoustic-warm',      prompt: 'warm acoustic guitar fingerstyle with soft percussion, for indie maker story, sincere and grounded' },

    // 积极正能量 (5 首)
    { name: 'creator-06-acoustic-bright',    prompt: 'bright acoustic guitar strumming with whistle melody, instrumental, for feel-good travel and growth vlog, optimistic and carefree' },
    { name: 'creator-07-strings-rising',     prompt: 'uplifting string ensemble slow build, hopeful orchestral, for growth and achievement video, triumphant but subtle' },
    { name: 'creator-08-piano-sunrise',      prompt: 'solo piano instrumental, sunrise mood, gentle ascending melody, for morning motivation and new day, peaceful optimism' },
    { name: 'creator-09-handpan-joy',        prompt: 'hang drum handpan with light percussion, joyful meditative, for authentic life moments, peaceful positivity' },
    { name: 'creator-10-whistle-adventure',  prompt: 'whistle-driven adventure folk instrumental, acoustic guitar and light percussion, for travel and adventure vlog, uplifting' },

    // 商务/出差/演讲 (5 首)
    { name: 'creator-11-jazz-bossa-light',   prompt: 'light bossa nova jazz trio, smooth brushes and nylon guitar, for business travel and keynote vlog, sophisticated and warm' },
    { name: 'creator-12-piano-elegant',      prompt: 'elegant piano instrumental with subtle strings, for keynote opening or customer-facing video, professional yet human' },
    { name: 'creator-13-guzheng-modern',     prompt: '古筝现代混搭,加入轻 lofi 鼓点和电钢琴,适合 AI 创业者出差 vlog,东方意境 + 现代节奏感,向上而克制' },
    { name: 'creator-14-strings-hopeful',    prompt: 'string quartet instrumental, hopeful but restrained, slow andante, for business growth story, serious and uplifting' },
    { name: 'creator-15-fingerstyle-pulse',  prompt: 'fingerstyle guitar with subtle electronic beat, indie hacker vibes, for solo founder on-the-road vlog, focused and moving forward' }
];

// ─── 第四批: 30 首 DJ 精选(不重复现有,6 大领域覆盖)──────────────────────────────
// 用户 2026-04-23 反馈:"扮演 DJ 大师 / 设计音乐大师,跑 30 首不同调性,好玩有趣"
// 策略:覆盖现有 43 首未覆盖的区域 —— 世界音乐 / 电子细分 / 影视 / 流行融合 / 好玩怪奇
const DJ_PROMPTS = [
    // ─── A. 世界音乐(10 首,现有基本没有这些)──────────────────
    { name: 'dj-01-sitar-raga-dawn',       prompt: 'Indian sitar solo raga, dawn Hindustani classical, meditative tanpura drone, contemplative slow alap, instrumental' },
    { name: 'dj-02-tabla-groove',          prompt: 'Indian tabla groove, rhythmic teental cycle, meditative yet driving, hypnotic tabla solo with light drone' },
    { name: 'dj-03-oud-arabia-night',      prompt: 'Middle Eastern oud solo, Arabic maqam scale, desert night melancholy, slow taqasim improvisation' },
    { name: 'dj-04-kora-west-africa',      prompt: 'West African kora harp solo, Mandinka style, flowing river, slow meditative mbalax feel, peaceful' },
    { name: 'dj-05-charango-andes',        prompt: 'Andean charango solo, Peruvian mountain morning, slow huayno melody, small guitar-like instrument' },
    { name: 'dj-06-shamisen-edo',          prompt: 'Japanese shamisen solo, traditional Edo period, slow nagauta style, plucked three strings' },
    { name: 'dj-07-gayageum-korea',        prompt: 'Korean gayageum solo, traditional 12-string zither, slow Sanjo style, royal court elegance' },
    { name: 'dj-08-didgeridoo-outback',    prompt: 'Australian didgeridoo drone, aboriginal outback, deep earth resonance, rhythmic breath cycles' },
    { name: 'dj-09-bansuri-morning',       prompt: 'Indian bansuri bamboo flute, morning raga bhairav, slow meditative, dhrupad style' },
    { name: 'dj-10-kanun-ottoman',         prompt: 'Ottoman qanun zither solo, Turkish makam, plucked trapezoidal harp, contemplative slow' },

    // ─── B. 电子细分(6 首,现有只有 ambient)──────────────────
    { name: 'dj-11-vaporwave-mall-80s',    prompt: 'vaporwave instrumental, 80s mall nostalgia, slow synth pads, reverb saxophone, pink aesthetic' },
    { name: 'dj-12-chillhop-rainy-cafe',   prompt: 'chillhop instrumental, rainy night cafe, jazz hop beats, warm vinyl crackle, lofi piano' },
    { name: 'dj-13-future-funk-sunset',    prompt: 'future funk instrumental, disco sampling, upbeat groovy, neon sunset energy, nu-disco' },
    { name: 'dj-14-deep-house-beach',      prompt: 'deep house instrumental, Ibiza beach sunset, mid-tempo 4/4, warm analog synths, progressive' },
    { name: 'dj-15-synthwave-night-drive', prompt: 'synthwave instrumental, night drive retro 80s, neon highway, arpeggiated synths, cinematic' },
    { name: 'dj-16-glitch-hop-warm',       prompt: 'glitch hop instrumental, warm imperfect beats, analog textures, melodic glitchy feel' },

    // ─── C. 影视/剧情感(5 首,现有没有)──────────────────
    { name: 'dj-17-cinematic-epic-rise',   prompt: 'cinematic epic orchestral, slow rising brass and strings, hero theme, triumphant ascending build' },
    { name: 'dj-18-noir-city-jazz',        prompt: 'film noir jazz, city at night, muted trumpet, detective mystery, smoky bar piano' },
    { name: 'dj-19-adventure-theme',       prompt: 'adventure theme orchestral instrumental, John Williams style, hopeful horns, sweeping strings, journey beginning' },
    { name: 'dj-20-tension-heartbeat',     prompt: 'cinematic tension build, slow heartbeat pulse, strings crescendo, suspense instrumental' },
    { name: 'dj-21-triumph-brass-finale',  prompt: 'triumphant brass finale, hero returns home, orchestral victory, cinematic ending' },

    // ─── D. 流行/融合 instrumental(5 首)──────────────────
    { name: 'dj-22-post-rock-soar',        prompt: 'post-rock instrumental, soaring delayed guitars, slow build to epic climax, Explosions in the Sky style' },
    { name: 'dj-23-americana-slide',       prompt: 'Americana slide guitar instrumental, desert highway sunset, resonator guitar, dusty country feel' },
    { name: 'dj-24-reggae-dub-beach',      prompt: 'reggae dub instrumental, beach sunset chill, laid back groove, organ and echo bass' },
    { name: 'dj-25-jazz-funk-groove',      prompt: 'jazz funk instrumental groove, 70s style, Rhodes electric piano, wah guitar, fat bass groove' },
    { name: 'dj-26-french-cafe-accordion', prompt: 'French cafe musette instrumental, accordion and manouche guitar, Parisian Montmartre vibe' },

    // ─── E. 好玩怪奇(4 首,现有完全没有)──────────────────
    { name: 'dj-27-8bit-chiptune-quest',   prompt: '8-bit chiptune instrumental, retro video game quest theme, NES style, adventurous upbeat, pixel art music' },
    { name: 'dj-28-ukulele-tropical-joy',  prompt: 'ukulele tropical island instrumental, sunny Hawaiian feel, whistle melody, happy carefree feel' },
    { name: 'dj-29-theremin-sci-fi',       prompt: 'theremin sci-fi instrumental, retro 50s space age, eerie wavering melody, B-movie atmosphere' },
    { name: 'dj-30-whistle-clockwork',     prompt: 'whistling with clockwork rhythm, quirky instrumental, wind-up toy vibes, Amélie Poulain style, playful mysterious' }
];

const SETS = {
    background: BACKGROUND_PROMPTS,
    solo: SOLO_PROMPTS,
    retry: RETRY_PROMPTS,
    creator: CREATOR_VIBES_PROMPTS,
    dj: DJ_PROMPTS
};

// 通过 --set solo|background 选批次(默认 background)
const setName = (process.argv.find((a) => a.startsWith('--set=')) || '--set=background').slice('--set='.length);
const PROMPTS = SETS[setName] || BACKGROUND_PROMPTS;

async function generateOne(item) {
    const body = {
        model: 'music-2.6',
        prompt: item.prompt,
        is_instrumental: true,
        audio_setting: {
            sample_rate: 44100,
            bitrate: 256000,
            format: 'mp3'
        },
        output_format: 'url'
    };

    const started = Date.now();
    let resp;
    try {
        resp = await axios.post(API_URL, body, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 240000,
            proxy: false
        });
    } catch (err) {
        const status = err.response?.status || 0;
        const data = err.response?.data;
        console.error(`  ✗ ${item.name} HTTP ${status}:`, JSON.stringify(data || err.message).slice(0, 200));
        return null;
    }

    const data = resp.data || {};
    const baseResp = data.base_resp || {};
    const inner = data.data || {};
    if (baseResp.status_code !== 0) {
        console.error(`  ✗ ${item.name} base_resp:`, baseResp);
        return null;
    }
    const audio = inner.audio;
    const status = inner.status;
    if (status !== 2 || !audio) {
        console.error(`  ✗ ${item.name} 未完成,status=${status}`);
        return null;
    }

    let buffer;
    try {
        if (String(audio).startsWith('http')) {
            const dl = await axios.get(audio, {
                responseType: 'arraybuffer',
                timeout: 120000,
                proxy: false
            });
            buffer = Buffer.from(dl.data);
        } else {
            buffer = Buffer.from(String(audio), 'hex');
        }
    } catch (err) {
        console.error(`  ✗ ${item.name} 下载失败:`, err.message);
        return null;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outPath = path.join(OUT_DIR, `${item.name}.mp3`);
    fs.writeFileSync(outPath, buffer);
    const duration = data.extra_info?.music_duration;
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ✓ ${item.name} -> ${outPath} (${(buffer.length / 1024).toFixed(0)} KB, ${duration ? (duration / 1000).toFixed(1) + 's' : '?'}, ${elapsed}s)`);
    return outPath;
}

(async () => {
    if (!API_KEY) {
        console.error('❌ MINIMAX_API_KEY 未设置,请在 .env 里配置');
        process.exit(1);
    }
    console.log(`🎵 MiniMax BGM 生成器\n   目标: ${OUT_DIR}\n   批次: ${setName}\n   共 ${PROMPTS.length} 首 instrumental\n`);

    const results = [];
    for (let i = 0; i < PROMPTS.length; i += 1) {
        const item = PROMPTS[i];
        console.log(`[${i + 1}/${PROMPTS.length}] ${item.name} -- ${item.prompt.slice(0, 60)}...`);
        const out = await generateOne(item);
        results.push({ name: item.name, prompt: item.prompt, output: out });
        // 小间隔避免触发限流
        if (i < PROMPTS.length - 1) {
            await new Promise((r) => setTimeout(r, 3000));
        }
    }

    const ok = results.filter((r) => r.output);
    console.log(`\n✓ done: ${ok.length}/${PROMPTS.length} 成功`);

    // 写 manifest
    const manifest = {
        generated_at: new Date().toISOString(),
        total: PROMPTS.length,
        success: ok.length,
        items: results.map((r) => ({
            name: r.name,
            prompt: r.prompt,
            file: r.output ? path.relative(path.resolve(__dirname, '..'), r.output) : null,
            status: r.output ? 'ok' : 'failed'
        }))
    };
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`  manifest: ${path.join(OUT_DIR, 'manifest.json')}`);
})();
