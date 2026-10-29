import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import './lib/bigint'; // makes BigInt ids JSON-serializable
import { config } from './config';
import { prisma } from './db';
import { HttpError } from './lib/errors';
import { ok } from './lib/respond';
import { errorHandler } from './middleware/errorHandler';

// Building the app in a function (instead of starting the server here) lets tests use it too.
// The ORDER of the lines below is the security design: Express runs them top to bottom.
export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // behind nginx later: makes req.ip the real client address
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGINS?.split(',') ?? false }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser()); // makes req.cookies available
  app.use(rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: true, legacyHeaders: false })); // 100 req/min/IP

  // ---- PUBLIC routes (registered BEFORE authenticate, which you add in C8) ----
  app.get('/api/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`; // proves the database connection works
    ok(res, { status: 'ok' });
  });

  // (C6+ add: app.use('/api/auth', publicAuthRouter) here, then authenticate, then the protected routers)

  app.use((_req, _res, next) => next(new HttpError(404, 'Not found'))); // nothing matched
  app.use(errorHandler); // must be the very last line
  return app;
}
