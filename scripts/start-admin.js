const { getConfig } = require('../src/config');
const { initDb } = require('../src/db');
const { ensureDefaultConfigs } = require('../src/db/configRepo');
const { startAdminServer } = require('../src/admin/server');

function main() {
    const config = getConfig({ requireTelegramToken: false });
    initDb(config.contentDbPath);
    ensureDefaultConfigs();
    startAdminServer(config);
}

main();
