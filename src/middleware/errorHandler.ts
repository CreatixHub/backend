import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors';

// The ONE place where errors become HTTP responses. Express 5 sends anything thrown (or rejected)
// inside a route handler here, so handlers never need try/catch for this.
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
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
  console.error(err); // log the details for yourself
  res.status(500).json({ message: 'Internal server error' }); // never show details to the client
};
