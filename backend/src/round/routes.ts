/** Expose the authenticated round command through the shared Express error boundary. */
import { Router, Request, Response, NextFunction } from 'express';
import { bearerToken } from '../session/routes';
import { RoundService } from './service';

/** Build the round router without another server or capability parser.
 * Args: service: atomic round authority.
 * Returns: Router with one POST command; failures propagate to centralized mapping.
 */
export function roundRouter(service: RoundService): Router {
  const router = Router();
  router.post('/', (req: Request, res: Response, next: NextFunction): void => {
    try {
      res.status(201).json({ session: service.play(bearerToken(req), req.body) });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
