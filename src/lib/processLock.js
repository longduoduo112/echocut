const fs = require('fs');
const path = require('path');

// 进程锁:防止本机并发跑两个 burn/highlights 导致 ffmpeg/MLX 抢资源崩掉。
// 文件内容是 PID,stale lock(对应进程已死)自动清。

function getLockPath(name) {
    const dir = path.join(process.cwd(), '.echo-locks');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        // kill(pid, 0) 不真 kill,只检查权限和存活性
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // ESRCH = 进程不存在(已死)
        // EPERM = 存活但没权限(活着)
        return err.code === 'EPERM';
    }
}

// 非阻塞获取锁,失败抛错(带描述性信息)。
// @param {string} name — 锁名,不同名之间互不影响(如 'burn.lock' / 'sync.lock')
// @param {object} opts
// @param {boolean} opts.allowWait — 是否提示等待建议
function acquireLock(name, opts = {}) {
    const lockPath = getLockPath(name);
    if (fs.existsSync(lockPath)) {
        let existingPid = 0;
        try { existingPid = Number(fs.readFileSync(lockPath, 'utf8').trim()); } catch (_) {}
        if (existingPid && isProcessAlive(existingPid)) {
            const hint = opts.allowWait
                ? `\n   等它跑完后重试,或 kill ${existingPid} 强制释放。`
                : '';
            throw new Error(`另一个 ${name.replace('.lock', '')} 任务正在运行 (PID ${existingPid})${hint}`);
        }
        // stale lock,清
        try { fs.unlinkSync(lockPath); } catch (_) {}
    }
    fs.writeFileSync(lockPath, String(process.pid));

    const release = () => {
        try {
            const content = fs.readFileSync(lockPath, 'utf8').trim();
            if (Number(content) === process.pid) {
                fs.unlinkSync(lockPath);
            }
        } catch (_) { /* lock 已被清,忽略 */ }
    };
    process.on('exit', release);
    process.on('SIGINT', () => { release(); process.exit(130); });
    process.on('SIGTERM', () => { release(); process.exit(143); });
    return release;
}

module.exports = { acquireLock };
