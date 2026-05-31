'use strict';

/**
 * 音乐 BGM 预设清单 · 各 set 对应一批同调性的 prompts
 *
 * 为什么单独一份:这样 echocut music 能 require 它而不必跑 scripts/generate-bgm.js
 * (后者顶层有 IIFE 会触发 API 调用,不能安全 require)
 *
 * 添加新 set:
 *   1. 定义 NEW_PROMPTS 数组 [{name, prompt}, ...]
 *   2. 加到 module.exports 的 key
 *   3. 立即可以 `echocut music --set=new`
 */

// ─── 第一批: 8 首风格各异的背景音 ─────────────────────────
const BACKGROUND = [
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
const SOLO = [
    { name: 'solo-01-ocarina-mountain',    prompt: '陶笛独奏,悠远空灵,山间雾气弥漫,慢节奏,带着古风禅意,中国传统乐器' },
    { name: 'solo-02-ocarina-cinematic',   prompt: 'epic ocarina solo, cinematic emotional melody, slow tempo, like Zelda Song of Storms, haunting and memorable' },
    { name: 'solo-03-ocarina-zen',         prompt: 'Asian ceramic ocarina solo, zen meditation, breathy and airy, slow contemplative, minimal reverb' },
    { name: 'solo-04-amazing-grace-piano',  prompt: 'Amazing Grace hymn, solo piano arrangement, slow spiritual, emotional, classic church version' },
    { name: 'solo-05-amazing-grace-violin', prompt: 'Amazing Grace, solo violin, sacred slow tempo, like Joshua Bell, churchlike reverence' },
    { name: 'solo-06-amazing-grace-guitar', prompt: 'Amazing Grace, solo fingerstyle acoustic guitar, peaceful spiritual, Tommy Emmanuel style' },
    { name: 'solo-07-uilleann-celtic',     prompt: 'Irish uilleann pipes solo, mournful celtic melody, traditional ballad, slow and soulful, bagpipes' },
    { name: 'solo-08-bagpipes-highland',   prompt: 'Scottish highland bagpipes solo, majestic slow movement, mountain winds, solemn dignity' },
    { name: 'solo-09-erhu-jiangnan',       prompt: '二胡独奏,江南水乡,深情婉转,慢板,抒情古风,像赛马前的宁静' },
    { name: 'solo-10-bamboo-flute',        prompt: '中国竹笛独奏,清幽悠远,月夜竹林,传统民乐,呼吸感强' },
    { name: 'solo-11-guzheng-flowing',     prompt: '古筝独奏,高山流水,春江花月夜风格,琴弦清脆,悠长' },
    { name: 'solo-12-pipa-tang',           prompt: '琵琶独奏,古典唐风,叙事性旋律,像十面埋伏的慢板' },
    { name: 'solo-13-xiao-meditation',     prompt: '洞箫独奏,禅意深远,高山空谷,气息悠长,古风禅意' },
    { name: 'solo-14-violin-baroque',      prompt: 'solo violin, baroque style slow movement, Bach Partita inspired, contemplative, unaccompanied' },
    { name: 'solo-15-cello-melancholy',    prompt: 'solo cello, melancholic slow andante, deep and reflective, like Bach Cello Suites' },
    { name: 'solo-16-piano-einaudi',       prompt: 'solo piano neoclassical, like Ludovico Einaudi or Yiruma, slow emotional, simple melody' },
    { name: 'solo-17-shakuhachi-zen',      prompt: 'Japanese shakuhachi bamboo flute solo, zen meditation, slow and breathy, monastery' },
    { name: 'solo-18-handpan-healing',     prompt: 'hang drum handpan solo, healing peaceful tones, slow meditation, steel tongue drum' },
    { name: 'solo-19-fingerstyle-guitar',  prompt: 'solo acoustic fingerstyle guitar, introspective, like Andy McKee or Sungha Jung, slow' },
    { name: 'solo-20-harmonica-blues',     prompt: 'solo harmonica, slow blues, late night reflection, soulful, minimal' }
];

// ─── 第三批: 15 首创业/成长/正能量(example 品牌基调)──────────────────
const CREATOR = [
    { name: 'creator-01-lofi-buildinpublic', prompt: 'modern upbeat lo-fi instrumental, subtle drum groove, warm synth pads, for indie hacker build-in-public video, focused and hopeful' },
    { name: 'creator-02-electronic-focus',   prompt: 'chill electronic instrumental, mid-tempo house, warm analog synths, for coding and startup vlog, motivating but not distracting' },
    { name: 'creator-03-piano-drive',        prompt: 'uplifting piano driven instrumental with light drum beat, progressive build, for startup journey video, determined and hopeful' },
    { name: 'creator-04-synth-journey',      prompt: 'cinematic synthwave slow build, retro 80s analog synth, for entrepreneur journey vlog, hopeful and expansive' },
    { name: 'creator-05-acoustic-warm',      prompt: 'warm acoustic guitar fingerstyle with soft percussion, for indie maker story, sincere and grounded' },
    { name: 'creator-06-acoustic-bright',    prompt: 'bright acoustic guitar strumming with whistle melody, instrumental, for feel-good travel and growth vlog, optimistic and carefree' },
    { name: 'creator-07-strings-rising',     prompt: 'uplifting string ensemble slow build, hopeful orchestral, for growth and achievement video, triumphant but subtle' },
    { name: 'creator-08-piano-sunrise',      prompt: 'solo piano instrumental, sunrise mood, gentle ascending melody, for morning motivation and new day, peaceful optimism' },
    { name: 'creator-09-handpan-joy',        prompt: 'hang drum handpan with light percussion, joyful meditative, for authentic life moments, peaceful positivity' },
    { name: 'creator-10-whistle-adventure',  prompt: 'whistle-driven adventure folk instrumental, acoustic guitar and light percussion, for travel and adventure vlog, uplifting' },
    { name: 'creator-11-jazz-bossa-light',   prompt: 'light bossa nova jazz trio, smooth brushes and nylon guitar, for business travel and keynote vlog, sophisticated and warm' },
    { name: 'creator-12-piano-elegant',      prompt: 'elegant piano instrumental with subtle strings, for keynote opening or customer-facing video, professional yet human' },
    { name: 'creator-13-guzheng-modern',     prompt: '古筝现代混搭,加入轻 lofi 鼓点和电钢琴,适合 AI 创业者出差 vlog,东方意境 + 现代节奏感,向上而克制' },
    { name: 'creator-14-strings-hopeful',    prompt: 'string quartet instrumental, hopeful but restrained, slow andante, for business growth story, serious and uplifting' },
    { name: 'creator-15-fingerstyle-pulse',  prompt: 'fingerstyle guitar with subtle electronic beat, indie hacker vibes, for solo founder on-the-road vlog, focused and moving forward' }
];

// ─── 第四批: 30 首 DJ 精选(6 大领域覆盖)──────────────────
const DJ = [
    // A. 世界音乐(10)
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
    // B. 电子细分(6)
    { name: 'dj-11-vaporwave-mall-80s',    prompt: 'vaporwave instrumental, 80s mall nostalgia, slow synth pads, reverb saxophone, pink aesthetic' },
    { name: 'dj-12-chillhop-rainy-cafe',   prompt: 'chillhop instrumental, rainy night cafe, jazz hop beats, warm vinyl crackle, lofi piano' },
    { name: 'dj-13-future-funk-sunset',    prompt: 'future funk instrumental, disco sampling, upbeat groovy, neon sunset energy, nu-disco' },
    { name: 'dj-14-deep-house-beach',      prompt: 'deep house instrumental, Ibiza beach sunset, mid-tempo 4/4, warm analog synths, progressive' },
    { name: 'dj-15-synthwave-night-drive', prompt: 'synthwave instrumental, night drive retro 80s, neon highway, arpeggiated synths, cinematic' },
    { name: 'dj-16-glitch-hop-warm',       prompt: 'glitch hop instrumental, warm imperfect beats, analog textures, melodic glitchy feel' },
    // C. 影视/剧情感(5)
    { name: 'dj-17-cinematic-epic-rise',   prompt: 'cinematic epic orchestral, slow rising brass and strings, hero theme, triumphant ascending build' },
    { name: 'dj-18-noir-city-jazz',        prompt: 'film noir jazz, city at night, muted trumpet, detective mystery, smoky bar piano' },
    { name: 'dj-19-adventure-theme',       prompt: 'adventure theme orchestral instrumental, John Williams style, hopeful horns, sweeping strings, journey beginning' },
    { name: 'dj-20-tension-heartbeat',     prompt: 'cinematic tension build, slow heartbeat pulse, strings crescendo, suspense instrumental' },
    { name: 'dj-21-triumph-brass-finale',  prompt: 'triumphant brass finale, hero returns home, orchestral victory, cinematic ending' },
    // D. 流行/融合(5)
    { name: 'dj-22-post-rock-soar',        prompt: 'post-rock instrumental, soaring delayed guitars, slow build to epic climax, Explosions in the Sky style' },
    { name: 'dj-23-americana-slide',       prompt: 'Americana slide guitar instrumental, desert highway sunset, resonator guitar, dusty country feel' },
    { name: 'dj-24-reggae-dub-beach',      prompt: 'reggae dub instrumental, beach sunset chill, laid back groove, organ and echo bass' },
    { name: 'dj-25-jazz-funk-groove',      prompt: 'jazz funk instrumental groove, 70s style, Rhodes electric piano, wah guitar, fat bass groove' },
    { name: 'dj-26-french-cafe-accordion', prompt: 'French cafe musette instrumental, accordion and manouche guitar, Parisian Montmartre vibe' },
    // E. 好玩怪奇(4)
    { name: 'dj-27-8bit-chiptune-quest',   prompt: '8-bit chiptune instrumental, retro video game quest theme, NES style, adventurous upbeat, pixel art music' },
    { name: 'dj-28-ukulele-tropical-joy',  prompt: 'ukulele tropical island instrumental, sunny Hawaiian feel, whistle melody, happy carefree feel' },
    { name: 'dj-29-theremin-sci-fi',       prompt: 'theremin sci-fi instrumental, retro 50s space age, eerie wavering melody, B-movie atmosphere' },
    { name: 'dj-30-whistle-clockwork',     prompt: 'whistling with clockwork rhythm, quirky instrumental, wind-up toy vibes, Amélie Poulain style, playful mysterious' }
];

module.exports = {
    background: BACKGROUND,
    solo: SOLO,
    creator: CREATOR,
    dj: DJ
};
