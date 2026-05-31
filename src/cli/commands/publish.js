const fs = require('fs');
const path = require('path');
const { uploadFile, listFiles, purgeOlderThan, getConfig } = require('../../services/storage');

const C = {
    gray: '\x1b[90m', reset: '\x1b[0m', cyan: '\x1b[36m',
    bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m'
};

function fmtSize(n) {
    if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n > 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${n} B`;
}

function fmtDays(ttlSec) {
    return `${(ttlSec / 86400).toFixed(0)} 天`;
}

module.exports = async function publish(target, opts) {
    const cfg = getConfig();

    // 子命令: --list / --purge / --status
    if (opts.list) {
        console.log(`\n${C.bold}${C.cyan}📦 storage list${C.reset}`);
        console.log(`   ${C.gray}endpoint${C.reset}  ${cfg.endpoint}`);
        console.log(`   ${C.gray}bucket${C.reset}    ${cfg.bucket}`);
        try {
            const files = await listFiles(opts.prefix || '');
            console.log(`   ${C.gray}文件数${C.reset}   ${files.length}`);
            console.log('');
            for (const f of files.slice(0, 50)) {
                const age = Math.floor((Date.now() - new Date(f.lastModified).getTime()) / 86400000);
                console.log(`  ${fmtSize(f.size).padStart(10)}  ${age}d  ${f.key}`);
            }
            if (files.length > 50) console.log(`  ${C.gray}... 省略 ${files.length - 50} 个${C.reset}`);
        } catch (err) {
            console.error(`${C.red}✗${C.reset} ${err.message}`);
            process.exit(1);
        }
        return;
    }

    if (opts.purge) {
        const days = Number(opts.purge) || 7;
        console.log(`\n${C.bold}${C.cyan}🧹 storage purge${C.reset}  ${C.gray}清理超过 ${days} 天的文件${C.reset}\n`);
        try {
            const res = await purgeOlderThan(days);
            console.log(`  扫描 ${res.totalScanned} 个,删除 ${C.green}${res.deleted}${C.reset} 个`);
        } catch (err) {
            console.error(`${C.red}✗${C.reset} ${err.message}`);
            process.exit(1);
        }
        return;
    }

    if (opts.status) {
        console.log(`\n${C.bold}${C.cyan}📊 storage status${C.reset}`);
        console.log(`   ${C.gray}endpoint${C.reset}  ${cfg.endpoint}`);
        console.log(`   ${C.gray}bucket${C.reset}    ${cfg.bucket}`);
        console.log(`   ${C.gray}region${C.reset}    ${cfg.region}`);
        console.log(`   ${C.gray}URL TTL${C.reset}   ${fmtDays(cfg.urlTtlSec)}`);
        try {
            const files = await listFiles('');
            const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
            console.log(`   ${C.gray}文件数${C.reset}   ${files.length}`);
            console.log(`   ${C.gray}总大小${C.reset}   ${fmtSize(totalSize)}`);
        } catch (err) {
            console.log(`   ${C.red}错误${C.reset}   ${err.message.slice(0, 100)}`);
        }
        return;
    }

    // 上传文件
    if (!target) {
        console.error(`${C.red}✗${C.reset} 需要指定文件路径: echocut publish <file>`);
        process.exit(1);
    }
    const absPath = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
    if (!fs.existsSync(absPath)) {
        console.error(`${C.red}✗${C.reset} 文件不存在: ${absPath}`);
        process.exit(1);
    }

    const brandId = opts.brand || 'default';
    console.log(`\n${C.bold}${C.cyan}📤 echocut publish${C.reset}`);
    console.log(`   ${C.gray}文件${C.reset}     ${path.basename(absPath)}`);
    console.log(`   ${C.gray}大小${C.reset}     ${fmtSize(fs.statSync(absPath).size)}`);
    console.log(`   ${C.gray}品牌${C.reset}     ${brandId}`);
    console.log(`   ${C.gray}endpoint${C.reset} ${cfg.endpoint}`);
    console.log(`   ${C.gray}bucket${C.reset}   ${cfg.bucket}`);
    console.log('');

    try {
        const started = Date.now();
        const res = await uploadFile({ filePath: absPath, brandId });
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(`  ${C.green}✓${C.reset} 上传完成 ${elapsed}s`);
        console.log(`  ${C.gray}key${C.reset}      ${res.key}`);
        console.log(`  ${C.gray}size${C.reset}     ${fmtSize(res.size)}`);
        console.log(`  ${C.gray}有效期${C.reset}   ${fmtDays(res.ttlSec)}\n`);
        console.log(`  ${C.bold}下载链接${C.reset}`);
        console.log(`  ${res.url}\n`);
    } catch (err) {
        console.error(`${C.red}✗${C.reset} 上传失败: ${err.message}`);
        if (err.message.includes('ECONNREFUSED')) {
            console.error(`${C.yellow}!${C.reset} MinIO 未启动?试试:`);
            console.error(`  docker run -d --name zde-minio -p 9000:9000 -p 9001:9001 \\`);
            console.error(`    -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin123 \\`);
            console.error(`    -v /tmp/zde-minio-data:/data minio/minio server /data --console-address ":9001"`);
        }
        process.exit(1);
    }
};
