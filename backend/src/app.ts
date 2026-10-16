/** Compose session and round APIs, bounded JSON parsing, liveness and sanitized errors. */
import express, { ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Config } from './config';
import { sessionRouter } from './session/routes';
import { SessionError, SessionService } from './session/service';
import { RoundService } from './round/service';
import { roundRouter } from './round/routes';

/** Create an app without starting a listener, so tests use the real HTTP boundary.
 * Args: service: shared session service; config: validated origin; rounds: optional constructor-injected round authority.
 * Returns: Express application; health never accesses the database.
 */
export function createApp(
  service: SessionService,
  config: Pick<Config, 'corsOrigin'>,
  rounds: RoundService = new RoundService(service)
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin }));
  app.get('/api/health', (_req, res) => { res.json({ status: 'ok' }); });
  app.use(express.json({ limit: '8kb', strict: true }));
  app.use('/api/v1/sessions', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, sessionRouter(service));
  app.use('/api/v1/rounds', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, roundRouter(rounds));
  app.use((_req, res) => { res.status(404).json({ error: 'Route not found.' }); });
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next): void => {
    if (error instanceof SessionError) {
      res.status(error.status).json({ error: error.message, ...(error.fields ? { fields: error.fields } : {}) });
      return;
    }
    const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
    if (type === 'entity.too.large') {
      res.status(413).json({ error: 'JSON body exceeds the 8 KB limit.' });
      return;
    }
    if (type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON body.' });
      return;
    }
    res.status(500).json({ error: 'The session service is unavailable. Please try again.' });
  };
  app.use(errorHandler);
  return app;
}
