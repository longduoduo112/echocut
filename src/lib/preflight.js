const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// 跨平台拿"真实可用内存(GB)"。
// ⚠️ macOS 上不能用 os.freemem()!那只返回 Pages free(完全空闲页),
//    macOS 统一内存架构会把大量内存当 cache(inactive/purgeable/speculative),
//    有压力时秒回收,Activity Monitor 也是这么算 "Memory Pressure" 的。
//    正确公式:available = free + inactive + speculative + purgeable
//    (compressor 是已压缩态,不直接计入可用,但有需要也能解压)
// Linux 用 /proc/meminfo 的 MemAvailable(内核已经算好的)
function getAvailableMemoryGB() {
    try {
        if (process.platform === 'darwin') {
            const out = execSync('vm_stat', { encoding: 'utf8', timeout: 2000 });
            // page size 通常 16384(M 系)或 4096(Intel),保险起见从 vm_stat 头部提取
            const sizeMatch = out.match(/page size of (\d+) bytes/);
            const pageSize = sizeMatch ? Number(sizeMatch[1]) : 4096;
            const grab = (label) => {
                const m = out.match(new RegExp(`${label}:\\s+(\\d+)`));
                return m ? Number(m[1]) : 0;
            };
            const free = grab('Pages free');
            const inactive = grab('Pages inactive');
            const speculative = grab('Pages speculative');
            const purgeable = grab('Pages purgeable');
            const availablePages = free + inactive + speculative + purgeable;
            return (availablePages * pageSize) / 1e9;
        }
        if (process.platform === 'linux' && fs.existsSync('/proc/meminfo')) {
            const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
            const m = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
            if (m) return Number(m[1]) * 1024 / 1e9;
        }
    } catch (_e) { /* 探测失败 fallback os.freemem() */ }
    return os.freemem() / 1e9;
}

// 跑前守门:磁盘/内存/大视频风险提示。失败时给明确英文退出码,
// 用户能根据提示解决后重试。
function preflightCheck(videoPath, opts = {}) {
    const errors = [];
    const warnings = [];

    // 磁盘:df -k . 算可用空间(GB)
    let freeDiskGB = 0;
    try {
        const out = execSync(`df -k "${process.cwd()}"`, { encoding: 'utf8' });
        const line = out.trim().split('\n').slice(-1)[0];
        const parts = line.split(/\s+/);
        const availKb = Number(parts[3]);
        freeDiskGB = availKb / 1024 / 1024;
    } catch (_e) { /* 探测失败就跳过 */ }

    // 视频体积估算
    let videoSizeGB = 0;
    if (videoPath && fs.existsSync(videoPath)) {
        videoSizeGB = fs.statSync(videoPath).size / 1e9;
    }

    // 预估需要磁盘:cut-fillers 中间文件 + burn 成片 + post-process ≈ 3x 源视频 + 余量
    const estimatedNeed = Math.max(5, videoSizeGB * 3 + 2);
    if (freeDiskGB > 0 && freeDiskGB < estimatedNeed) {
        errors.push(
            `磁盘不足:视频 ${videoSizeGB.toFixed(1)}GB,预估需要 ${estimatedNeed.toFixed(1)}GB,`
            + `当前空闲 ${freeDiskGB.toFixed(1)}GB。参考 docs/TROUBLESHOOTING.md 清理命令。`
        );
    } else if (freeDiskGB > 0 && freeDiskGB < estimatedNeed + 10) {
        warnings.push(
            `磁盘紧张:空闲 ${freeDiskGB.toFixed(1)}GB,预估需要 ${estimatedNeed.toFixed(1)}GB,`
            + `跑完后建议清理 debug_outputs/。`
        );
    }

    // 内存:MLX HQ 要 6-8GB 空闲
    // 用 available(含 inactive/purgeable 等可立即回收的)而不是 os.freemem()
    const availRamGB = getAvailableMemoryGB();
    const totalRamGB = os.totalmem() / 1e9;
    if (availRamGB < 2) {
        errors.push(
            `内存严重不足:可用 ${availRamGB.toFixed(1)}GB / 总 ${totalRamGB.toFixed(1)}GB。`
            + `关掉 Chrome/微信/飞书等大户再试。MLX HQ 最少需要 2GB+,推荐 6GB+。`
        );
    } else if (availRamGB < 4 && (opts.engine || 'mlx_hq').includes('mlx_hq')) {
        warnings.push(
            `内存偏紧:可用 ${availRamGB.toFixed(1)}GB。MLX HQ 推荐 6GB+,可能慢或偶发 crash。`
        );
    }

    // 大视频警告:> 2GB 进入长视频路径
    if (videoSizeGB > 2) {
        warnings.push(
            `大视频 ${videoSizeGB.toFixed(1)}GB:整条流水线预计 ${Math.round(videoSizeGB * 3)} 分钟以上,`
            + `建议用 tmux/screen 避免 SSH 断开导致中断。`
        );
    }

    // 输出
    if (warnings.length) {
        console.log('\n\x1b[33m⚠\x1b[0m  preflight 提示:');
        warnings.forEach((w) => console.log('   ' + w));
    }
    if (errors.length) {
        console.error('\n\x1b[31m✗\x1b[0m  preflight 失败:');
        errors.forEach((e) => console.error('   ' + e));
        console.error('');
        if (opts.force || process.env.ZDE_SKIP_PREFLIGHT === '1') {
            console.log('\x1b[33m⚠\x1b[0m  ZDE_SKIP_PREFLIGHT=1 或 --force,强行继续(请自负后果)\n');
            return;
        }
        console.error('   如确认要跑,设 ZDE_SKIP_PREFLIGHT=1 绕过此检查。\n');
        process.exit(1);
    }
}

module.exports = { preflightCheck, getAvailableMemoryGB };
