import type { TenantContext } from '../lib/tenant';
import type { AuthUser } from '../middleware/authenticate';

// Teaches TypeScript that our authenticate middleware adds req.user and req.tenant.
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser; // set by authenticate: WHO is calling
      tenant?: TenantContext; // set by authenticate when the token carries a school
    }
  }
}

export {};
