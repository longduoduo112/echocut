const path = require('path');
const { fork } = require('child_process');
const { startBot } = require('./src/app');

const childFlag = 'ECHO_BOT_CHILD_PROCESS';

function startChildProcess() {
    process.on('unhandledRejection', (reason) => {
        const error = reason instanceof Error ? reason : new Error(String(reason || 'unknown rejection'));
        console.error('未捕获 Promise 异常:', error.message);
        throw error;
    });
    process.on('uncaughtException', (error) => {
        console.error('未捕获异常，子进程退出并等待守护重启:', error.message);
        process.exit(1);
    });
    startBot().catch((error) => {
        console.error('启动失败:', error.message);
        process.exit(1);
    });
}

function startSupervisorProcess() {
    const restartDelayBase = Math.max(500, Number(process.env.APP_WATCHDOG_RESTART_DELAY_MS || 1500));
    const restartDelayMax = Math.max(restartDelayBase, Number(process.env.APP_WATCHDOG_MAX_RESTART_DELAY_MS || 30000));
    const restartJitter = Math.max(0, Number(process.env.APP_WATCHDOG_RESTART_JITTER_MS || 800));
    let child = null;
    let shuttingDown = false;
    let restartCount = 0;
    let restartTimer = null;

    const clearRestartTimer = () => {
        if (!restartTimer) return;
        clearTimeout(restartTimer);
        restartTimer = null;
    };

    const scheduleRestart = () => {
        if (shuttingDown) return;
        restartCount += 1;
        const expo = Math.min(5, restartCount - 1);
        const delay = Math.min(restartDelayMax, restartDelayBase * (2 ** expo)) + Math.floor(Math.random() * (restartJitter + 1));
        console.error(`守护进程准备重启子进程，第 ${restartCount} 次，延迟 ${delay}ms`);
        clearRestartTimer();
        restartTimer = setTimeout(() => {
            spawnChild();
        }, delay);
    };

    const spawnChild = () => {
        if (shuttingDown) return;
        const scriptPath = path.join(__dirname, 'index.js');
        child = fork(scriptPath, [], {
            env: { ...process.env, [childFlag]: '1' },
            stdio: 'inherit'
        });
        child.once('spawn', () => {
            restartCount = 0;
            console.log(`🛡️ 守护进程已拉起子进程 pid=${child.pid}`);
        });
        child.on('exit', (code, signal) => {
            if (shuttingDown) return;
            const bySignal = Boolean(signal) && (signal === 'SIGINT' || signal === 'SIGTERM');
            if (bySignal) return;
            console.error(`子进程异常退出 code=${code ?? 'null'} signal=${signal || 'none'}`);
            scheduleRestart();
        });
        child.on('error', (error) => {
            if (shuttingDown) return;
            console.error('子进程错误:', error.message);
            scheduleRestart();
        });
    };

    const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        clearRestartTimer();
        if (child && !child.killed) {
            try {
                child.kill(signal);
            } catch (_) {
            }
        }
        setTimeout(() => process.exit(0), 300).unref();
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    spawnChild();
}

if (process.env[childFlag] === '1') {
    startChildProcess();
} else {
    startSupervisorProcess();
}
