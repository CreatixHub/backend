import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';

// The ONE place where errors become HTTP responses. Express 5 sends anything thrown (or rejected)
// inside a route handler here, so handlers never need try/catch for this.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      message: 'Validation failed',
      errors: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ message: err.message, errors: err.errors });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ message: 'Invalid JSON' });
    return;
  }
  logger.error({ err, method: req.method, url: req.url }, 'Unhandled error');
  res.status(500).json({ message: 'Internal server error' }); // never show details to the client
};
