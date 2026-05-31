/**
 * 任务队列、状态机与 Dashboard 管理
 */
const { createLogger } = require('../services/logger');
const {
    upsertTaskCheckpoint,
    updateTaskCheckpointProgress,
    updateTaskCheckpointStatus,
    insertTaskStageMetric,
    listTaskStageMetrics
} = require('../db/taskCheckpointRepo');
const { runWithBotNetworkRetry } = require('./botSend');
const { isVideoMessage, isImageMessage } = require('./msgUtils');

const logger = createLogger({ name: 'bot' });

// 可变队列状态
const taskQueue = [];
let queueRunningWorkers = 0;
let queueMaxConcurrency = 1;

const dashboardState = {
    tasks: new Map(),
    telegramBoards: new Map(),
    timer: null,
    lastConsoleFrame: ''
};

function setQueueConcurrency(n) {
    queueMaxConcurrency = Math.max(1, Math.min(4, Number(n) || 1));
}

function formatMs(ms) {
    return `${(ms / 1000).toFixed(2)}s`;
}

function nowLabel() {
    return new Date().toISOString();
}

function createStageTracker(taskId, taskType) {
    const stageCost = {};
    return {
        stageCost,
        record(stageKey, stageTitle, beginAt, { contentId = 0, status = 'done' } = {}) {
            if (!Number.isFinite(beginAt)) return 0;
            const elapsedMs = Math.max(0, Date.now() - beginAt);
            stageCost[stageKey] = elapsedMs;
            insertTaskStageMetric({
                taskId,
                taskType,
                stageKey,
                stageTitle,
                elapsedMs,
                status,
                contentId
            });
            return elapsedMs;
        },
        recordFixed(stageKey, stageTitle, elapsedMs, { contentId = 0, status = 'done' } = {}) {
            const normalized = Math.max(0, Math.floor(Number(elapsedMs) || 0));
            stageCost[stageKey] = normalized;
            insertTaskStageMetric({
                taskId,
                taskType,
                stageKey,
                stageTitle,
                elapsedMs: normalized,
                status,
                contentId
            });
            return normalized;
        }
    };
}

function getQueueStatus() {
    return { waiting: taskQueue.length, running: queueRunningWorkers, concurrency: queueMaxConcurrency };
}

function getQueueDepth() {
    return taskQueue.length + queueRunningWorkers;
}

function inferTaskTypeFromMessage(msg) {
    if (msg?.voice || msg?.audio) return 'audio';
    if (isVideoMessage(msg)) return 'video';
    if (isImageMessage(msg)) return 'image';
    return 'text';
}

function getTaskTotalSteps(taskType) {
    if (taskType === 'video') return 7;
    if (taskType === 'audio') return 8;
    if (taskType === 'image') return 4;
    return 3;
}

function registerTaskForDashboard({ taskId, chatId, session, taskType, queueNo }) {
    dashboardState.tasks.set(taskId, {
        taskId,
        chatId,
        session,
        taskType,
        status: 'queued',
        queueNo,
        stepNo: 0,
        totalNo: getTaskTotalSteps(taskType),
        stepTitle: '排队中',
        progressPct: 0,
        createdAt: Date.now(),
        startedAt: 0,
        stageStartedAt: 0,
        endedAt: 0,
        updatedAt: Date.now(),
        error: ''
    });
    upsertTaskCheckpoint({
        taskId,
        chatId,
        session,
        taskType,
        status: 'queued',
        payload: {},
        stepNo: 0,
        totalNo: getTaskTotalSteps(taskType),
        stepTitle: '排队中',
        progressPct: 0,
        errorText: ''
    });
}

function markTaskRunning(taskId) {
    const task = dashboardState.tasks.get(taskId);
    if (!task) return;
    task.status = 'running';
    task.startedAt = Date.now();
    task.updatedAt = Date.now();
    if (!task.stepNo) task.stepNo = 1;
    if (!task.progressPct) task.progressPct = 1;
    if (!task.stageStartedAt) task.stageStartedAt = Date.now();
    updateTaskCheckpointStatus(taskId, 'running', {
        stepTitle: task.stepTitle,
        progressPct: task.progressPct
    });
}

function updateTaskStep(taskId, { stepNo, totalNo, stepTitle, progressPct }) {
    const task = dashboardState.tasks.get(taskId);
    if (!task) return;
    let changed = false;
    const nextStepNo = Number.isFinite(stepNo) ? Math.max(0, Math.floor(stepNo)) : task.stepNo;
    const nextStepTitle = typeof stepTitle === 'string' && stepTitle.trim() ? stepTitle.trim() : task.stepTitle;
    if (nextStepNo !== task.stepNo || nextStepTitle !== task.stepTitle) changed = true;
    if (Number.isFinite(stepNo)) task.stepNo = Math.max(0, Math.floor(stepNo));
    if (Number.isFinite(totalNo)) task.totalNo = Math.max(1, Math.floor(totalNo));
    if (typeof stepTitle === 'string' && stepTitle.trim()) task.stepTitle = stepTitle.trim();
    if (Number.isFinite(progressPct)) task.progressPct = Math.max(0, Math.min(100, Math.floor(progressPct)));
    if (changed) task.stageStartedAt = Date.now();
    task.updatedAt = Date.now();
    updateTaskCheckpointProgress(taskId, {
        stepNo: task.stepNo,
        totalNo: task.totalNo,
        stepTitle: task.stepTitle,
        progressPct: task.progressPct
    });
}

function markTaskDone(taskId) {
    const task = dashboardState.tasks.get(taskId);
    if (!task) return;
    task.status = 'done';
    task.endedAt = Date.now();
    task.updatedAt = Date.now();
    task.progressPct = 100;
    task.stepNo = task.totalNo;
    task.stepTitle = '已完成';
    task.stageStartedAt = task.endedAt;
    updateTaskCheckpointStatus(taskId, 'done', {
        stepTitle: task.stepTitle,
        progressPct: 100
    });
}

function markTaskFailed(taskId, error) {
    const task = dashboardState.tasks.get(taskId);
    if (!task) return;
    task.status = 'failed';
    task.endedAt = Date.now();
    task.updatedAt = Date.now();
    task.error = String(error?.message || error || 'unknown error');
    task.stepTitle = `失败: ${task.error.slice(0, 48)}`;
    task.stageStartedAt = task.endedAt;
    updateTaskCheckpointStatus(taskId, 'failed', {
        errorText: task.error,
        stepTitle: task.stepTitle,
        progressPct: task.progressPct
    });
}

function pruneDashboardTasks() {
    const now = Date.now();
    for (const [taskId, task] of dashboardState.tasks.entries()) {
        const finished = task.status === 'done' || task.status === 'failed';
        if (finished && now - task.updatedAt > 10 * 60 * 1000) {
            dashboardState.tasks.delete(taskId);
        }
    }
}

function formatTaskAge(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const mm = Math.floor(sec / 60);
    const ss = sec % 60;
    return `${mm}m${String(ss).padStart(2, '0')}s`;
}

function getTaskOrderWeight(status) {
    if (status === 'running') return 0;
    if (status === 'queued') return 1;
    if (status === 'failed') return 2;
    return 3;
}

function resolveTaskClock(task, now) {
    const finished = task.status === 'done' || task.status === 'failed';
    const refNow = finished ? (task.endedAt || task.updatedAt || now) : now;
    const totalBase = task.startedAt || task.createdAt || refNow;
    const stageBase = task.stageStartedAt || task.startedAt || task.createdAt || refNow;
    return {
        totalAge: formatTaskAge(Math.max(0, refNow - totalBase)),
        stageAge: formatTaskAge(Math.max(0, refNow - stageBase))
    };
}

function buildDashboardLines() {
    const tasks = Array.from(dashboardState.tasks.values())
        .sort((a, b) => (
            getTaskOrderWeight(a.status) - getTaskOrderWeight(b.status)
            || (a.startedAt || a.createdAt) - (b.startedAt || b.createdAt)
        ));
    const running = tasks.filter((t) => t.status === 'running');
    const queued = tasks.filter((t) => t.status === 'queued');
    const failed = tasks.filter((t) => t.status === 'failed');
    const done = tasks.filter((t) => t.status === 'done');
    const now = Date.now();
    const lines = [];
    lines.push('╔════════════════ TASK DASHBOARD ════════════════╗');
    lines.push(`时间 ${new Date(now).toLocaleTimeString('zh-CN', { hour12: false })} | 运行 ${running.length} | 等待 ${queued.length} | 失败 ${failed.length} | 完成 ${done.length}`);
    lines.push(`队列状态 running=${queueRunningWorkers} waiting=${taskQueue.length} concurrency=${queueMaxConcurrency}`);
    if (!tasks.length) {
        lines.push('暂无任务');
    } else {
        for (const task of tasks.slice(0, 8)) {
            const { totalAge, stageAge } = resolveTaskClock(task, now);
            const statusTag = task.status === 'running' ? 'RUN' : task.status === 'queued' ? 'Q' : task.status === 'failed' ? 'FAIL' : 'DONE';
            const pct = Number.isFinite(task.progressPct) ? `${String(task.progressPct).padStart(3, ' ')}%` : ' --%';
            lines.push(`[${statusTag}] ${task.taskId} ${task.taskType} ${task.stepNo}/${task.totalNo} ${pct} ${totalAge}`);
            if (task.status === 'done') {
                lines.push(`      已完成 (总耗时 ${totalAge}) | ${task.session}`);
            } else if (task.status === 'failed') {
                lines.push(`      ${task.stepTitle} (总耗时 ${totalAge}) | ${task.session}`);
            } else {
                lines.push(`      ${task.stepTitle} (${stageAge}) | ${task.session}`);
            }
        }
    }
    lines.push('╚════════════════════════════════════════════════╝');
    return lines;
}

function renderConsoleDashboardFrame() {
    pruneDashboardTasks();
    const frame = `${buildDashboardLines().join('\n')}\n`;
    if (frame === dashboardState.lastConsoleFrame) return;
    dashboardState.lastConsoleFrame = frame;
    if (!process.stdout.isTTY) {
        process.stdout.write(frame);
        return;
    }
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(frame);
}

function buildTelegramDashboardText(chatId, maxLen) {
    const allTasks = Array.from(dashboardState.tasks.values())
        .filter((task) => String(task.chatId) === String(chatId))
        .sort((a, b) => (b.updatedAt - a.updatedAt));
    const running = allTasks.filter((t) => t.status === 'running').length;
    const queued = allTasks.filter((t) => t.status === 'queued').length;
    const failed = allTasks.filter((t) => t.status === 'failed').length;
    const done = allTasks.filter((t) => t.status === 'done').length;
    const lines = [];
    lines.push('📊 任务看板（实时）');
    lines.push(`运行 ${running} | 等待 ${queued} | 失败 ${failed} | 完成 ${done}`);
    lines.push(`全局队列: running=${queueRunningWorkers}, waiting=${taskQueue.length}, concurrency=${queueMaxConcurrency}`);
    lines.push('');
    const now = Date.now();
    for (const task of allTasks.slice(0, 6)) {
        const { totalAge, stageAge } = resolveTaskClock(task, now);
        const statusTag = task.status === 'running' ? '▶️' : task.status === 'queued' ? '⏳' : task.status === 'failed' ? '❌' : '✅';
        const pct = Number.isFinite(task.progressPct) ? `${task.progressPct}%` : '--%';
        lines.push(`${statusTag} ${task.taskId} [${task.taskType}] ${task.stepNo}/${task.totalNo} ${pct} ${totalAge}`);
        if (task.status === 'done') {
            lines.push(`   已完成 (总耗时 ${totalAge})`);
        } else if (task.status === 'failed') {
            lines.push(`   ${task.stepTitle} (总耗时 ${totalAge})`);
        } else {
            lines.push(`   ${task.stepTitle} (${stageAge})`);
        }
    }
    const text = lines.join('\n');
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 24))}\n...`;
}

function buildTaskStageMetricsText(taskId, maxLen = 3000) {
    const rows = listTaskStageMetrics(taskId, 120);
    if (!rows.length) return `未找到任务 ${taskId} 的阶段耗时记录`;
    const totalMs = rows.reduce((sum, item) => sum + Math.max(0, Number(item.elapsed_ms || 0)), 0);
    const lines = [];
    lines.push(`⏱️ 阶段耗时明细`);
    lines.push(`任务: ${taskId}`);
    lines.push(`记录数: ${rows.length} | 累计耗时: ${formatMs(totalMs)}`);
    lines.push('');
    for (const row of rows) {
        const status = row.status === 'failed' ? '❌' : row.status === 'skipped' ? '⏭️' : '✅';
        lines.push(`${status} ${row.stage_title || row.stage_key} | ${formatMs(row.elapsed_ms || 0)} | ${row.task_type}`);
    }
    const text = lines.join('\n');
    if (text.length <= maxLen) return text;
    return `${text.slice(0, Math.max(0, maxLen - 24))}\n...`;
}

async function refreshTelegramDashboards(bot, config) {
    const chatIds = new Set();
    for (const task of dashboardState.tasks.values()) {
        chatIds.add(String(task.chatId));
    }
    for (const chatId of chatIds) {
        const text = buildTelegramDashboardText(chatId, config.maxMessageLength);
        if (!text) continue;
        const state = dashboardState.telegramBoards.get(chatId) || {
            messageId: 0,
            lastText: '',
            lastEditAt: 0,
            backoffUntil: 0
        };
        const now = Date.now();
        if (now < state.backoffUntil) {
            dashboardState.telegramBoards.set(chatId, state);
            continue;
        }
        if (text === state.lastText) {
            dashboardState.telegramBoards.set(chatId, state);
            continue;
        }
        if (state.messageId && now - state.lastEditAt < 1200) {
            dashboardState.telegramBoards.set(chatId, state);
            continue;
        }
        try {
            if (!state.messageId) {
                const sent = await runWithBotNetworkRetry(() => bot.sendMessage(chatId, `${text}\n▌`), config, 'dashboard_send');
                state.messageId = sent.message_id;
            } else {
                await runWithBotNetworkRetry(() => bot.editMessageText(`${text}\n▌`, {
                    chat_id: chatId,
                    message_id: state.messageId
                }), config, 'dashboard_edit');
            }
            state.lastText = text;
            state.lastEditAt = now;
            state.backoffUntil = 0;
        } catch (error) {
            const code = Number(error?.response?.body?.error_code || error?.code || 0);
            const message = String(error?.response?.body?.description || error?.message || '');
            const retryAfter = Number(error?.response?.body?.parameters?.retry_after || 0);
            if (code === 429 || /retry after/i.test(message)) {
                state.backoffUntil = now + Math.max(2000, retryAfter * 1000);
            } else if (/message is not modified/i.test(message)) {
                state.lastEditAt = now;
            } else if (/message to edit not found/i.test(message)) {
                state.messageId = 0;
            } else {
                logger.warn('dashboard.telegram.refresh_failed', { chatId, code, message: message.slice(0, 160) });
            }
        }
        dashboardState.telegramBoards.set(chatId, state);
    }
}

function startDashboardLoop(bot, config) {
    if (dashboardState.timer) return;
    dashboardState.timer = setInterval(() => {
        renderConsoleDashboardFrame();
        refreshTelegramDashboards(bot, config).catch((error) => {
            logger.warn('dashboard.telegram.loop_error', { message: error.message });
        });
    }, 1000);
}

function enqueueTask(payload) {
    return new Promise((resolve, reject) => {
        taskQueue.push({ payload, resolve, reject, enqueuedAt: Date.now() });
        logger.info('queue.enqueued', { queueWaiting: taskQueue.length, running: queueRunningWorkers, concurrency: queueMaxConcurrency });
        consumeQueue().catch((error) => {
            console.error('队列消费异常:', error);
            logger.error('queue.consume.error', { message: error.message });
        });
    });
}

async function consumeQueue() {
    while (queueRunningWorkers < queueMaxConcurrency && taskQueue.length) {
        const item = taskQueue.shift();
        if (!item) return;
        queueRunningWorkers += 1;
        const queueWaitMs = Date.now() - item.enqueuedAt;
        logger.info('queue.task.start', {
            taskId: item.payload?.taskId || '',
            queueWaitMs,
            queueWaiting: taskQueue.length,
            running: queueRunningWorkers,
            concurrency: queueMaxConcurrency
        });
        if (item.payload?.taskId) {
            markTaskRunning(item.payload.taskId);
        }
        Promise.resolve()
            .then(() => item.payload.run())
            .then((result) => {
                if (item.payload?.taskId) {
                    markTaskDone(item.payload.taskId);
                }
                logger.info('queue.task.done', {
                    taskId: item.payload?.taskId || '',
                    queueWaiting: taskQueue.length,
                    running: queueRunningWorkers
                });
                item.resolve(result);
            })
            .catch((error) => {
                if (item.payload?.taskId) {
                    markTaskFailed(item.payload.taskId, error);
                }
                logger.error('queue.task.failed', { message: error.message, stack: String(error.stack || '').slice(0, 1000) });
                item.reject(error);
            })
            .finally(() => {
                queueRunningWorkers = Math.max(0, queueRunningWorkers - 1);
                if (!taskQueue.length && queueRunningWorkers === 0) {
                    logger.info('queue.consume.idle', { queueWaiting: 0, running: 0 });
                }
                consumeQueue().catch((error) => {
                    logger.error('queue.consume.error', { message: error.message });
                });
            });
    }
}

function getTask(taskId) {
    return dashboardState.tasks.get(taskId) || null;
}

module.exports = {
    setQueueConcurrency,
    formatMs,
    nowLabel,
    createStageTracker,
    getQueueStatus,
    getQueueDepth,
    inferTaskTypeFromMessage,
    getTaskTotalSteps,
    registerTaskForDashboard,
    markTaskRunning,
    updateTaskStep,
    markTaskDone,
    markTaskFailed,
    pruneDashboardTasks,
    buildTaskStageMetricsText,
    startDashboardLoop,
    enqueueTask,
    consumeQueue,
    getTask
};
