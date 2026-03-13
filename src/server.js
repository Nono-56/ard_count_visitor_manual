const { createPasswordHash } = require('./auth');
const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { SQLiteRepository } = require('./repository');

async function main() {
  const config = loadConfig();
  const repo = new SQLiteRepository(config.sqlitePath);
  await repo.init();

  await repo.syncSettings({
    eventName: config.eventName,
    eventDate: config.eventDate,
    eventEndDate: config.eventEndDate,
    timezone: config.eventTimezone,
    publicHostname: config.publicHostname,
    staffPasswordHash: createPasswordHash(config.appPassword)
  });

  const app = createApp({ repo, config });
  const server = app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
  });

  const shutdown = async () => {
    server.close(async () => {
      await repo.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
