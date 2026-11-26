/** What the planner demo seed is about to write to. Never contains the user name or password. */
export interface SeedTarget {
  host: string;
  port: string;
  database: string;
}

export interface SeedEnv {
  NODE_ENV?: string;
  PLANNER_SEED_ALLOW_HOST?: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
// Connection-string parameters that can replace the host (or load one from a service file).
const OVERRIDING_PARAMS = new Set(['host', 'hostaddr', 'service']);

/**
 * Decide whether the planner demo seed may write to `databaseUrl`. Pure: reads nothing from the
 * process or the network, so it can run (and be tested) before any database client is created.
 *
 * - NODE_ENV=production is always refused, even for a local host and even with the opt-in variable.
 * - Only localhost, 127.0.0.1 and ::1 are accepted by default.
 * - Any other host is refused unless PLANNER_SEED_ALLOW_HOST equals that exact hostname.
 * - A host, hostaddr or service query parameter is always refused: it can override the host in the URL.
 *
 * Throws an Error that says why. Error messages and the returned summary never contain the
 * credentials or the full URL.
 */
export function assertSeedTarget(databaseUrl: string | undefined, env: SeedEnv): SeedTarget {
  if (env.NODE_ENV === 'production') {
    throw new Error('The planner demo seed cannot run in production.');
  }
  if (!databaseUrl) {
    throw new Error('Set DATABASE_URL to a local database before seeding the planner demo.');
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid connection URL, so the planner demo seed cannot tell where it would write.');
  }
  // pg-connection-string lets these query parameters override the host in the URL, so a URL that reads as
  // localhost could still connect somewhere else. Refuse them outright.
  for (const key of url.searchParams.keys()) {
    if (OVERRIDING_PARAMS.has(key.toLowerCase())) {
      throw new Error(
        'DATABASE_URL has a host, hostaddr or service query parameter, which can send the connection to a different host '
        + 'than the one in the URL. Remove it so the planner demo seed can tell where it would write.',
      );
    }
  }
  // Node keeps the brackets on an IPv6 host ("[::1]"); compare the bare address.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!host) {
    throw new Error('DATABASE_URL has no host name, so the planner demo seed cannot tell where it would write.');
  }

  if (!LOCAL_HOSTS.has(host) && env.PLANNER_SEED_ALLOW_HOST !== host) {
    throw new Error(
      `Refusing to seed the planner demo into "${host}": it is not a local database. `
      + `The seed creates a user, a school, roles, staff and lessons. If you really mean to write to this host, `
      + `set PLANNER_SEED_ALLOW_HOST=${host} for this run.`,
    );
  }

  return { host, port: url.port || '5432', database: decodeURIComponent(url.pathname.replace(/^\//, '')) };
}
