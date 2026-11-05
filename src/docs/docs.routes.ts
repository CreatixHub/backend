import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { config } from '../config';
import { buildOpenApiDocument } from './openapi';

// The documentation is on while developing and OFF in production (NODE_ENV=production), because public docs hand
// attackers a map of the API. Set DOCS_ENABLED=true or false in the environment to override either way.
export const docsEnabled = config.DOCS_ENABLED ? config.DOCS_ENABLED === 'true' : config.NODE_ENV !== 'production';

// Mounted on /api in app.ts, BEFORE authenticate: the docs page itself needs no login
// (you sign in on the page, then use Authorize).
export function docsRouter() {
  const spec = buildOpenApiDocument();
  const router = Router();

  // helmet's default policy adds "upgrade-insecure-requests", which would turn the page's own scripts into https
  // requests and break it on a plain-http server. Relax just that one directive, only for the docs.
  router.use(['/docs', '/openapi.json'], helmet.contentSecurityPolicy({ useDefaults: true, directives: { 'upgrade-insecure-requests': null } }));

  router.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });

  router.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Karkaii API',
      swaggerOptions: { persistAuthorization: true, docExpansion: 'list', validatorUrl: null },
    }),
  );

  return router;
}
