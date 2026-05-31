const path = require('path');
const { spawn } = require('child_process');

module.exports = async function studio() {
    const root = process.env.ZDE_PROJECT_ROOT || process.cwd();
    const port = process.env.ADMIN_PORT || 3399;
    console.log(`\n\x1b[1m\x1b[36m🎛  echocut studio\x1b[0m`);
    console.log(`   \x1b[90m打开\x1b[0m   http://localhost:${port}`);
    console.log('');

    const child = spawn('node', ['scripts/start-admin.js'], { stdio: 'inherit', cwd: root });
    child.on('exit', (code) => process.exit(code || 0));
    child.on('error', (err) => {
        console.error(`\x1b[31m✗\x1b[0m 启动失败:`, err.message);
        process.exit(1);
    });
};
