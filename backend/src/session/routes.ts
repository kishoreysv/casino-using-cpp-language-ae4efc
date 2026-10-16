/** Expose only creation, recovery and idempotent stop through the session boundary. */
import { Router, Request, Response, NextFunction } from 'express';
import { SessionError, SessionService } from './service';

/** Parse exactly one Bearer capability; reject alternate schemes and extra data.
 * Args: request: incoming Express request.
 * Returns: token or undefined, leaving authorization to the service.
 */
export function bearerToken(request: Request): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.get('authorization') ?? '');
  return match?.[1];
}

/** Build routes around the runtime's reusable session service.
 * Args: service: shared authenticated business operations.
 * Returns: mountable Express router.
 */
export function sessionRouter(service: SessionService): Router {
  const router = Router();
  router.post('/', (req: Request, res: Response, next: NextFunction): void => {
    try {
      if (!req.is('application/json')) throw new SessionError(400, 'Send an application/json body.');
      res.status(201).json(service.create(req.body));
    } catch (error) { next(error); }
  });
  router.get('/current', (req: Request, res: Response, next: NextFunction): void => {
    try { res.json({ session: service.current(bearerToken(req)) }); }
    catch (error) { next(error); }
  });
  router.post('/stop', (req: Request, res: Response, next: NextFunction): void => {
    try { res.json({ session: service.stop(bearerToken(req)) }); }
    catch (error) { next(error); }
  });
  return router;
}
