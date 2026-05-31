const { spawn } = require('child_process');

// 流式跑 ffmpeg,解析 stderr 的 time= 转成百分比回调。
// 所有 ffmpeg 编码任务(cut-fillers / burn / post-process)共享此工具,
// 保证有一致的 onProgress 接口和非阻塞行为(不会卡住 event loop 导致 spinner 不转)。
function runFfmpegWithProgress(ffmpegArgs, { durationSec = 0, onProgress = null, timeoutMs = 15 * 60 * 1000 } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderrBuf = '';
        let timer = null;
        let settled = false;
        // 统一的资源回收:取消定时器 + 摘监听 + 强杀残留进程
        // 必须在 resolve/reject 前调用,否则进程 orphan 会持续抢 CPU/GPU(今早事故根因)
        const cleanup = () => {
            if (settled) return;
            settled = true;
            if (timer) { clearTimeout(timer); timer = null; }
            try { proc.stderr && proc.stderr.removeAllListeners(); } catch (_) {}
            proc.removeAllListeners('close');
            proc.removeAllListeners('error');
            if (proc.exitCode == null && proc.signalCode == null) {
                try { proc.kill('SIGKILL'); } catch (_) {}
            }
        };
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                cleanup();
                reject(new Error(`ffmpeg timeout after ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs);
        }
        const timeRe = /time=(\d+):(\d+):(\d+\.?\d*)/;
        proc.stderr.on('data', (chunk) => {
            const line = chunk.toString();
            stderrBuf += line;
            if (onProgress && durationSec > 0) {
                const m = line.match(timeRe);
                if (m) {
                    const elapsed = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
                    const pct = Math.min(99, Math.floor(elapsed / durationSec * 100));
                    onProgress(pct);
                }
            }
        });
        proc.on('close', (code) => {
            cleanup();
            if (code === 0) {
                if (onProgress) onProgress(100);
                resolve({ stderr: stderrBuf });
            } else {
                reject(new Error(`ffmpeg exited with code ${code}\n${stderrBuf.slice(-2000)}`));
            }
        });
        proc.on('error', (err) => {
            cleanup();
            reject(err);
        });
    });
}

module.exports = { runFfmpegWithProgress };
