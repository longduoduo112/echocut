const https = require('https');
const http = require('http');

const SERVER = process.env.ECHO_SERVER || 'https://example.com';
const ADMIN_USER = process.env.ECHO_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ECHO_ADMIN_PASS || 'Echo@2026!zd';

const C = {
    bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
    green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
    blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m'
};

function fmtSize(n) {
    if (!n) return '-';
    if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
    if (n > 1024) return `${(n / 1024).toFixed(0)}KB`;
    return `${n}B`;
}

function fmtStatus(s) {
    const map = {
        pending: `${C.yellow}待处理${C.reset}`,
        processing: `${C.blue}处理中${C.reset}`,
        done: `${C.green}已完成${C.reset}`,
        failed: `${C.red}失败${C.reset}`
    };
    return map[s] || s;
}

async function apiCall(path, method, body, cookie) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, SERVER);
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

module.exports = async function tasks(opts) {
    console.log(`\n${C.bold}${C.cyan}📋 echocut tasks${C.reset}`);
    console.log(`${C.gray}   服务器  ${SERVER}${C.reset}\n`);

    try {
        // Login
        const login = await apiCall('/api/auth/login', 'POST', { username: ADMIN_USER, password: ADMIN_PASS });
        if (!login.data.ok) {
            console.error(`${C.red}✗ 登录失败${C.reset}`);
            process.exit(1);
        }
        const cookie = (login.cookie || []).map(c => c.split(';')[0]).join('; ');

        // Fetch tasks (API returns array directly or {tasks:[...]})
        const res = await apiCall('/api/admin/tasks', 'GET', null, cookie);
        const taskList = Array.isArray(res.data) ? res.data : (res.data.tasks || []);

        // Fetch users
        const usersRes = await apiCall('/api/admin/users', 'GET', null, cookie);
        const users = Array.isArray(usersRes.data) ? usersRes.data : (usersRes.data.users || []);

        // Filter
        let filtered = taskList;
        if (opts.user) {
            filtered = filtered.filter(t => t.username === opts.user);
        }
        if (!opts.all) {
            // Default: show pending + processing + recent done (last 5)
            const active = filtered.filter(t => t.status === 'pending' || t.status === 'processing');
            const done = filtered.filter(t => t.status === 'done').slice(0, 5);
            const failed = filtered.filter(t => t.status === 'failed').slice(0, 3);
            filtered = [...active, ...done, ...failed];
        }

        // Stats
        const pending = taskList.filter(t => t.status === 'pending').length;
        const processing = taskList.filter(t => t.status === 'processing').length;
        const done = taskList.filter(t => t.status === 'done').length;
        const failed = taskList.filter(t => t.status === 'failed').length;

        console.log(`${C.bold}  概览${C.reset}  ${C.gray}${users.length} 用户 | ${taskList.length} 任务${C.reset}`);
        console.log(`        ${C.yellow}${pending} 待处理${C.reset} | ${C.blue}${processing} 处理中${C.reset} | ${C.green}${done} 完成${C.reset} | ${C.red}${failed} 失败${C.reset}\n`);

        if (!filtered.length) {
            console.log(`  ${C.gray}(无任务)${C.reset}`);
            return;
        }

        // Table
        console.log(`  ${C.gray}${'ID'.padEnd(5)}${'用户'.padEnd(14)}${'文件名'.padEnd(32)}${'大小'.padEnd(10)}${'状态'.padEnd(12)}时间${C.reset}`);
        console.log(`  ${C.gray}${'─'.repeat(85)}${C.reset}`);
        for (const t of filtered) {
            const id = String(t.id).padEnd(5);
            const user = String(t.username || '?').padEnd(12);
            const name = String(t.original_filename || '').slice(0, 30).padEnd(30);
            const size = fmtSize(t.file_size).padEnd(8);
            const status = fmtStatus(t.status);
            const time = t.created_at ? t.created_at.slice(0, 16).replace('T', ' ') : '';
            console.log(`  ${id}  ${user}  ${name}  ${size}  ${status}  ${C.gray}${time}${C.reset}`);
        }

        if (!opts.all && taskList.length > filtered.length) {
            console.log(`\n  ${C.gray}(显示 ${filtered.length}/${taskList.length} 条,加 --all 看全部)${C.reset}`);
        }

        if (pending > 0) {
            console.log(`\n  ${C.yellow}→ ${pending} 条待处理。用 echocut sync 开始处理${C.reset}`);
            console.log(`  ${C.gray}  echocut sync                    # 按时间顺序处理所有${C.reset}`);
            console.log(`  ${C.gray}  echocut sync --task-id 5         # 只处理 #5${C.reset}`);
            console.log(`  ${C.gray}  echocut sync --loop              # 持续轮询${C.reset}`);
        }
        console.log('');
    } catch (err) {
        console.error(`${C.red}✗ ${err.message}${C.reset}`);
        process.exit(1);
    }
};
