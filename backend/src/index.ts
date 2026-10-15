/** Start the compiled API and close SQLite only after the HTTP listener has drained. */
import { loadConfig } from './config';
import { SessionRepository } from './session/repository';
import { SessionService } from './session/service';
import { createApp } from './app';

const config = loadConfig();
const repository = new SessionRepository(config.databaseUrl);
const service = new SessionService(repository);
const server = createApp(service, config).listen(config.port, '0.0.0.0', () => {
  console.info(`Tenfold API listening on port ${config.port}`);
});

/** Drain active HTTP requests and close the persistent connection on termination. */
function shutdown(): void {
  server.close(() => { repository.close(); });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
server.on('error', (error: Error) => {
  console.error(`HTTP listener failed: ${error.message}`);
  repository.close();
  process.exitCode = 1;
});
