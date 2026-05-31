const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync, spawn } = require('child_process');

const SERVER = process.env.ECHO_SERVER || 'https://example.com';
const SSH_HOST = process.env.ECHO_SSH || 'root@14.103.216.255';
const ADMIN_USER = process.env.ECHO_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ECHO_ADMIN_PASS || 'Echo@2026!zd';
const ROOT = process.env.ZDE_PROJECT_ROOT || process.cwd();
const TMP_DIR = path.join(ROOT, 'tmp', 'sync');

const C = {
    bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
    blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m'
};

function log(msg) { process.stdout.write(`${C.gray}[${new Date().toLocaleTimeString()}]${C.reset} ${msg}\n`); }
function ok(msg) { process.stdout.write(`${C.green}✓${C.reset} ${msg}\n`); }
function warn(msg) { process.stdout.write(`${C.yellow}!${C.reset} ${msg}\n`); }
function err(msg) { process.stdout.write(`${C.red}✗${C.reset} ${msg}\n`); }

function apiCall(urlPath, method, body, cookie) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, SERVER);
        const mod = url.protocol === 'https:' ? https : http;
        const opts = {
            hostname: url.hostname, port: url.port || undefined, path: url.pathname,
            method: method || 'GET',
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        };
        if (cookie) opts.headers.Cookie = cookie;
        const req = mod.request(opts, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data), cookie: res.headers['set-cookie'] }); }
                catch (e) { resolve({ status: res.statusCode, data: {}, cookie: res.headers['set-cookie'] }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function login() {
    const res = await apiCall('/api/auth/login', 'POST', { username: ADMIN_USER, password: ADMIN_PASS });
    if (!res.data.ok) throw new Error('登录失败');
    return (res.cookie || []).map(c => c.split(';')[0]).join('; ');
}

async function getPendingTasks(cookie) {
    const res = await apiCall('/api/admin/tasks', 'GET', null, cookie);
    const tasks = Array.isArray(res.data) ? res.data : (res.data.tasks || []);
    return tasks.filter(t => t.status === 'pending');
}

async function updateTaskStatus(cookie, taskId, status, outputPath, errorMsg) {
    const body = { status };
    if (outputPath) body.output_path = outputPath;
    if (errorMsg) body.error_msg = errorMsg;
    await apiCallRetry(`/api/admin/tasks/${taskId}`, 'PUT', body, cookie);
}

function scp(from, to) {
    try {
        execSync(`scp -q "${from}" "${to}"`, { timeout: 600000 });
        return true;
    } catch (e) {
        return false;
    }
}

// brand.cover_path 是服务器绝对路径(如 /mnt/data/echo/brands/8/cover-1776345255374.jpeg),
// 直接写到本地 brand.json 会让 coverGenerator 找不到文件。这里 scp 拉到本地。
// 本地文件名 = 服务器 basename(带时间戳),保证用户在 admin 换封面后服务器路径变化能命中 miss
// 自动拉新的。旧封面留在本地不主动清理(都是几 MB 小图,不值得在 sync 流程里同步删除)。
// 失败返回 null,让上层退化到 example 默认模板。
function syncBrandCover(serverPath, brandSubDir) {
    if (!serverPath || typeof serverPath !== 'string') return null;
    if (!serverPath.startsWith('/')) return serverPath; // 已经是相对路径,假设本地存在
    try {
        fs.mkdirSync(brandSubDir, { recursive: true });
        const baseName = path.basename(serverPath);
        const localPath = path.join(brandSubDir, baseName);
        if (fs.existsSync(localPath)) return localPath; // 已拉过同名文件,服务器没换图
        if (!scp(`${SSH_HOST}:${serverPath}`, localPath)) return null;
        return localPath;
    } catch (_e) {
        return null;
    }
}

async function apiCallRetry(urlPath, method, body, cookie, retries) {
    retries = retries || 3;
    for (let i = 0; i <= retries; i++) {
        try {
            return await apiCall(urlPath, method, body, cookie);
        } catch (e) {
            if (i < retries) {
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }
            throw e;
        }
    }
}

// client 上传时若 multipart filename 编码已损坏(常见 iOS Safari/微信),
// DB 里 original_filename 会含 U+FFFD(replacement char,UTF-8 \xef\xbf\xbd),
// 直接拿来当本地文件名 ffmpeg 不报错但视觉上不可读、log 一片乱码。
function sanitizeFilename(name, taskId) {
    if (!name) return `task_${taskId}.mp4`;
    if (name.includes('�')) {
        const ext = (path.extname(name) || '.mp4').toLowerCase().match(/^\.[a-z0-9]{1,5}$/) ? path.extname(name).toLowerCase() : '.mp4';
        return `task_${taskId}${ext}`;
    }
    return name;
}

async function processTask(_cookie, task) {
    const { id, user_id, upload_path, original_filename, username } = task;
    const safeFilename = sanitizeFilename(original_filename, id);
    const displayName = original_filename === safeFilename
        ? safeFilename
        : `${safeFilename} ${C.gray}(原名乱码,已兜底)${C.reset}`;
    log(`${C.bold}[Task #${id}]${C.reset} ${displayName} ${C.gray}(用户: ${username || '?'})${C.reset}`);

    // 1. Download
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const localVideo = path.join(TMP_DIR, `${id}-${safeFilename}`);
    log(`  下载 ${SSH_HOST}:${upload_path} ...`);
    if (!scp(`${SSH_HOST}:${upload_path}`, localVideo)) {
        err(`  下载失败`);
        try { await updateTaskStatus(_cookie, id, 'failed', null, '服务器下载原始文件失败,请重试或重新上传'); } catch (_) {}
        return false;
    }
    const sizeKB = Math.round(fs.statSync(localVideo).size / 1024);
    ok(`  下载完成 (${sizeKB > 1024 ? (sizeKB / 1024).toFixed(1) + 'MB' : sizeKB + 'KB'})`);

    // 2. Re-login + Update to processing
    let cookie;
    try {
        cookie = await login();
    } catch (e) {
        warn(`  re-login 失败,用原 cookie`);
        cookie = _cookie;
    }
    await apiCallRetry(`/api/admin/tasks/${id}`, 'PUT', { status: 'processing' }, cookie);

    // 3. 从服务器拉取用户品牌配置,生成本地 brand.json
    //    用户在网站填的品牌信息存在服务器 DB,本地不一定有
    //    SaaS 链路兜底:不再退化到 example(那是 Bill 自己的形象,会污染他人视频),
    //    改用 _default 中性模板 + 运行时把 username 注入到 brandTag/identity.name。
    //    这样新用户即使没配品牌,出来的视频也是自己的名字 + echocut 中性封面。
    let brandId = '_default';
    let brandResolved = false;
    try {
        // 用管理员身份查看该用户的品牌信息(admin API 返回所有任务带 username)
        const brandRes = await apiCallRetry(`/api/admin/brand/${user_id}`, 'GET', null, cookie);
        const brandData = brandRes.data;
        if (brandData && brandData.nickname) {
            // 生成临时 brand.json
            const safeName = String(username || user_id).replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
            brandId = safeName;
            const brandDir = path.join(ROOT, 'configs', 'brands');
            const brandFile = path.join(brandDir, `${safeName}.json`);
            // \u628a\u670d\u52a1\u5668\u5c01\u9762\u62c9\u5230\u672c\u5730 configs/brands/<safeName>/cover-template.<ext>
            const localCoverDir = path.join(brandDir, safeName);
            const localCover = syncBrandCover(brandData.cover_path, localCoverDir);
            if (!localCover && brandData.cover_path) {
                warn(`  \u5c01\u9762\u62c9\u53d6\u5931\u8d25,\u9000\u56de example \u9ed8\u8ba4\u6a21\u677f (${brandData.cover_path})`);
            }
            const brand = {
                id: safeName,
                displayName: brandData.nickname || username,
                schemaVersion: 1,
                identity: {
                    name: brandData.nickname || username || '',
                    realName: brandData.real_name || '',
                    title: brandData.title || '',
                    slogan: brandData.slogan || '',
                    description: brandData.description || '',
                    // v0.9+ 双语 tagline(admin 页面可编辑)
                    taglineZh: brandData.tagline_zh || '',
                    taglineEn: brandData.tagline_en || ''
                },
                visual: {
                    brandTag: brandData.brand_tag || `@${brandData.nickname || username || ''}`,
                    tagBgColor: brandData.tag_bg_color || '#FFD54F',
                    tagTextColor: brandData.tag_text_color || '#0B0F1A',
                    coverTemplate: localCover || 'configs/brands/example/cover-template.png'
                },
                cta: {
                    enabled: true,
                    title: `关注 ${brandData.brand_tag || '@' + (brandData.nickname || '')}`,
                    subtitle: brandData.slogan || '',
                    // v0.9+ 长短双 CTA(afc / article / 朋友圈短文都用)
                    articleFooter: brandData.article_footer || '',
                    shortFooter: brandData.short_footer || ''
                },
                bgm: { defaultName: '03-lofi-podcast', defaultVolume: 0.08 },
                llm: {
                    personaBase: `你是"${brandData.nickname || username}"的数字分身。\n核心身份:${brandData.description || ''}\n行文铁律:短句成段,移动端呼吸感,一针见血。\n绝对禁止 AI 套话。`
                },
                asrDomainKeywords: (brandData.asr_keywords || '').split(',').map(s => s.trim()).filter(Boolean)
            };
            fs.writeFileSync(brandFile, JSON.stringify(brand, null, 2), 'utf8');
            ok(`  品牌 "${brandData.nickname}" → ${safeName}.json`);
            brandResolved = true;
        } else {
            warn(`  用户 ${username || user_id} 未配置品牌,用 _default 中性模板 + 用户名注入`);
        }
    } catch (e) {
        warn(`  拉取品牌失败(${e.message}),用 _default 中性模板`);
    }

    // 用户没配品牌 → 基于 _default 模板生成临时 brand.json,brandTag/displayName 注入 username
    // 这样视频里出现的是 "@<用户名>" 而不是 "@example",彻底切断他人视频用 Bill 形象的链路。
    if (!brandResolved) {
        try {
            const safeName = String(username || user_id).replace(/[^a-zA-Z0-9一-鿿_-]/g, '_') || `user${user_id}`;
            const defaultTplPath = path.join(ROOT, 'configs', 'brands', '_default.json');
            const defaultTpl = JSON.parse(fs.readFileSync(defaultTplPath, 'utf8'));
            const niceName = String(username || `创作者${user_id}`);
            // 深拷贝模板 + 运行时注入用户身份字段
            const brand = JSON.parse(JSON.stringify(defaultTpl));
            brand.id = `_user_${safeName}`;
            brand.displayName = niceName;
            brand.identity.name = niceName;
            brand.visual.brandTag = `@${niceName}`;
            // coverTemplate 已是 _default 中性模板的相对路径(coverGenerator 解析项目根目录)
            const userBrandFile = path.join(ROOT, 'configs', 'brands', `_user_${safeName}.json`);
            fs.writeFileSync(userBrandFile, JSON.stringify(brand, null, 2), 'utf8');
            brandId = `_user_${safeName}`;
            ok(`  中性品牌 → @${niceName} (_user_${safeName}.json)`);
        } catch (e) {
            warn(`  _default 模板加载失败(${e.message}),退回 _default 不注入用户名`);
        }
    }
    const brandFile = path.join(ROOT, 'configs', 'brands', `${brandId}.json`);
    const brandArg = fs.existsSync(brandFile) ? `--brand ${brandId}` : '';

    // 4. Process — 默认带 cut-fillers + cut-silence（口播标配）
    log(`  开始处理 (--cut-fillers --cut-silence) ...`);
    const started = Date.now();

    return new Promise((resolve) => {
        const args = [
            'burn', localVideo,
            '--cut-fillers', '--cut-silence'
        ];
        if (brandArg) args.push(...brandArg.split(' '));

        const child = spawn('echocut', args, {
            stdio: 'inherit',
            cwd: ROOT
        });

        child.on('exit', async (code) => {
            const elapsed = ((Date.now() - started) / 1000).toFixed(1);
            if (code !== 0) {
                err(`  处理失败 (exit ${code}, ${elapsed}s)`);
                const stats = fs.existsSync(localVideo) ? fs.statSync(localVideo) : null;
                const isBad = stats && stats.size < 2 * 1024 * 1024;
                const msg = isBad
                    ? `上传的视频文件不完整(${(stats.size/1024/1024).toFixed(1)}MB),请在信号好的环境重新上传`
                    : '视频处理失败,可能是文件损坏或不支持的格式,请重新上传或联系管理员';
                await updateTaskStatus(cookie, id, 'failed', null, msg);
                try { fs.unlinkSync(localVideo); } catch (_) {}
                resolve(false);
                return;
            }

            // 5. Find output
            const outputDirs = fs.readdirSync(path.join(ROOT, 'debug_outputs', 'video'))
                .sort().reverse();
            let burnFile = '';
            for (const dir of outputDirs.slice(0, 3)) {
                const found = findFile(path.join(ROOT, 'debug_outputs', 'video', dir), '_burn.mp4');
                if (found) { burnFile = found; break; }
            }

            if (!burnFile) {
                err(`  找不到成片`);
                await updateTaskStatus(cookie, id, 'failed', null, '成片产出异常,请重试');
                resolve(false);
                return;
            }

            ok(`  处理完成 (${elapsed}s)`);

            // 6. 生成 360p 低码率预览版（页面预览秒开）
            const previewFile = burnFile.replace(/_burn\.mp4$/, '_preview360.mp4');
            log(`  生成预览版 (360p)...`);
            try {
                execSync(`ffmpeg -y -i "${burnFile}" -vf "scale=-2:360" -c:v libx264 -preset fast -crf 28 -c:a aac -b:a 96k -movflags +faststart "${previewFile}"`, { timeout: 120000 });
                ok(`  预览版 ${Math.round(fs.statSync(previewFile).size / 1024)}KB`);
            } catch (e) {
                warn(`  预览版生成失败(非致命): ${e.message.slice(0, 80)}`);
            }

            // 7. Upload 成片 + 预览版
            const remotePath = `/mnt/data/echo/outputs/${user_id}/${id}-${path.basename(burnFile)}`;
            const remotePreview = remotePath.replace(/_burn\.mp4$/, '_preview360.mp4').replace(/\.mp4$/, '_preview360.mp4');
            log(`  上传成片...`);
            execSync(`ssh ${SSH_HOST} "mkdir -p /mnt/data/echo/outputs/${user_id}/"`, { timeout: 10000 });
            if (scp(burnFile, `${SSH_HOST}:${remotePath}`)) {
                // 上传预览版(小文件,快)
                if (fs.existsSync(previewFile)) {
                    scp(previewFile, `${SSH_HOST}:${remotePreview}`);
                }
                await updateTaskStatus(cookie, id, 'done', remotePath);
                ok(`  上传完成 → 用户可下载`);
            } else {
                err(`  上传失败`);
                await updateTaskStatus(cookie, id, 'failed', null, '成片回传服务器失败,请重试');
            }

            // 7. Cleanup temp
            try { fs.unlinkSync(localVideo); } catch (_) {}

            resolve(true);
        });

        child.on('error', async (e) => {
            err(`  spawn 失败: ${e.message}`);
            await updateTaskStatus(cookie, id, 'failed');
            resolve(false);
        });
    });
}

function findFile(dir, suffix) {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isFile() && e.name.endsWith(suffix)) return full;
            if (e.isDirectory()) {
                const found = findFile(full, suffix);
                if (found) return found;
            }
        }
    } catch (_) {}
    return '';
}

module.exports = async function sync(opts) {
    console.log(`\n${C.bold}${C.cyan}🔄 echocut sync${C.reset}`);
    console.log(`${C.gray}   服务器  ${SERVER}${C.reset}`);
    console.log(`${C.gray}   SSH     ${SSH_HOST}${C.reset}`);
    if (opts.taskId) console.log(`${C.gray}   指定任务  #${opts.taskId}${C.reset}`);
    console.log('');

    // Dashboard mode
    if (opts.dashboard) {
        const dashboard = path.join(ROOT, 'scripts', 'sync-dashboard.sh');
        if (fs.existsSync(dashboard)) {
            const { spawnSync } = require('child_process');
            spawnSync('bash', [dashboard, '--loop'], { stdio: 'inherit', cwd: ROOT });
            return;
        }
    }

    const runOnce = async () => {
        try {
            const cookie = await login();
            const pending = await getPendingTasks(cookie);

            if (opts.taskId) {
                // 指定处理某一条
                const target = pending.find(t => String(t.id) === String(opts.taskId));
                if (!target) {
                    // 也尝试从所有任务找
                    const allRes = await apiCall('/api/admin/tasks', 'GET', null, cookie);
                    const allTasks = Array.isArray(allRes.data) ? allRes.data : (allRes.data.tasks || []);
                    const t = allTasks.find(x => String(x.id) === String(opts.taskId));
                    if (!t) {
                        err(`任务 #${opts.taskId} 不存在`);
                        return;
                    }
                    if (t.status !== 'pending' && t.status !== 'failed') {
                        warn(`任务 #${opts.taskId} 状态是 ${t.status},跳过 (只处理 pending/failed)`);
                        return;
                    }
                    await processTask(cookie, t);
                } else {
                    await processTask(cookie, target);
                }
                return;
            }

            // 按时间顺序处理所有 pending
            if (!pending.length) {
                log(`${C.dim}没有待处理任务${C.reset}`);
                return;
            }

            log(`发现 ${C.bold}${pending.length}${C.reset} 条待处理任务`);
            const sorted = pending.sort((a, b) => (a.id || 0) - (b.id || 0));

            for (let i = 0; i < sorted.length; i++) {
                log(`\n${C.bold}[${i + 1}/${sorted.length}]${C.reset}`);
                await processTask(cookie, sorted[i]);
            }

            ok(`\n本轮处理完成 (${sorted.length} 条)`);
        } catch (e) {
            err(`同步失败: ${e.message}`);
        }
    };

    if (opts.loop) {
        const interval = typeof opts.loop === 'string' ? parseInt(opts.loop) || 120 : 120;
        log(`${C.bold}持续轮询模式${C.reset} 每 ${interval}s (Ctrl+C 停止)`);
        while (true) {
            await runOnce();
            log(`${C.dim}等待 ${interval}s...${C.reset}`);
            await new Promise(r => setTimeout(r, interval * 1000));
        }
    } else {
        await runOnce();
    }
};
