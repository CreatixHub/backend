import { describe, expect, it } from 'vitest';
import { assertSeedTarget } from '../scripts/seedGuard';

// DB-free: assertSeedTarget is a pure function and imports nothing from the app or src/db.
const PASSWORD = 'S3cret-p4ss-DoNotLeak';
const urlFor = (host: string, port = '5432') => `postgresql://planner_user:${PASSWORD}@${host}:${port}/karkaii_dev`;
const HOSTED = 'aws-0-ap-northeast-2.pooler.supabase.com';

describe('planner demo seed guard', () => {
  it.each([
    ['localhost', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['[::1]', '::1'],
  ])('allows the local host %s without any opt-in', (written, expected) => {
    const target = assertSeedTarget(urlFor(written, '5433'), {});
    expect(target).toEqual({ host: expected, port: '5433', database: 'karkaii_dev' });
  });

  it('reports the default port when the URL has none', () => {
    expect(assertSeedTarget(`postgres://u:${PASSWORD}@localhost/karkaii_dev`, {}).port).toBe('5432');
  });

  it('refuses a hosted database by default and names the host and the opt-in variable', () => {
    expect(() => assertSeedTarget(urlFor(HOSTED, '6543'), {})).toThrow(/Refusing to seed/);
    expect(() => assertSeedTarget(urlFor(HOSTED, '6543'), {})).toThrow(HOSTED);
    expect(() => assertSeedTarget(urlFor(HOSTED, '6543'), {})).toThrow(/PLANNER_SEED_ALLOW_HOST/);
  });

  it('allows a hosted database only when PLANNER_SEED_ALLOW_HOST equals that exact host', () => {
    const target = assertSeedTarget(urlFor(HOSTED, '6543'), { PLANNER_SEED_ALLOW_HOST: HOSTED });
    expect(target).toEqual({ host: HOSTED, port: '6543', database: 'karkaii_dev' });
  });

  it.each([
    ['a different host', 'db.other-project.supabase.co'],
    ['a parent domain', 'supabase.com'],
    ['a longer host', `${HOSTED}.evil.test`],
    ['an empty value', ''],
    ['a wildcard', '*'],
  ])('still refuses a hosted database when PLANNER_SEED_ALLOW_HOST is %s', (_label, allowed) => {
    expect(() => assertSeedTarget(urlFor(HOSTED), { PLANNER_SEED_ALLOW_HOST: allowed })).toThrow(/Refusing to seed/);
  });

  it('refuses NODE_ENV=production for a local host and with the opt-in variable', () => {
    expect(() => assertSeedTarget(urlFor('localhost'), { NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => assertSeedTarget(urlFor(HOSTED), { NODE_ENV: 'production', PLANNER_SEED_ALLOW_HOST: HOSTED }))
      .toThrow(/production/);
    expect(() => assertSeedTarget(urlFor('localhost'), { NODE_ENV: 'production', PLANNER_SEED_ALLOW_HOST: 'localhost' }))
      .toThrow(/production/);
  });

  it('allows other NODE_ENV values', () => {
    expect(assertSeedTarget(urlFor('localhost'), { NODE_ENV: 'development' }).host).toBe('localhost');
    expect(assertSeedTarget(urlFor('localhost'), { NODE_ENV: 'test' }).host).toBe('localhost');
  });

  it.each([
    ['missing', undefined, /DATABASE_URL/],
    ['empty', '', /DATABASE_URL/],
    ['not a URL', 'definitely not a url', /not a valid connection URL/],
    ['host-less', 'postgresql:///karkaii_dev', /host/],
  ])('refuses a %s DATABASE_URL with a clear message', (_label, value, message) => {
    expect(() => assertSeedTarget(value, {})).toThrow(message);
    // Even the opt-in variable cannot make an unreadable target acceptable.
    expect(() => assertSeedTarget(value, { PLANNER_SEED_ALLOW_HOST: 'localhost' })).toThrow(message);
  });

  it.each([
    ['host', '?host=remote.example'],
    ['HOST (upper case)', '?HOST=remote.example'],
    ['hostaddr', '?hostaddr=203.0.113.9'],
    ['service', '?service=prod'],
    ['host after another parameter', '?sslmode=disable&Host=remote.example'],
    ['an empty host', '?host='],
  ])('refuses a local URL carrying a %s query parameter, which would override the host', (_label, query) => {
    const url = `${urlFor('localhost')}${query}`;
    expect(() => assertSeedTarget(url, {})).toThrow(/query parameter/);
    // Neither the opt-in variable nor a hosted allow-list entry can make it acceptable.
    expect(() => assertSeedTarget(url, { PLANNER_SEED_ALLOW_HOST: 'localhost' })).toThrow(/query parameter/);
    expect(() => assertSeedTarget(`${urlFor(HOSTED)}${query}`, { PLANNER_SEED_ALLOW_HOST: HOSTED })).toThrow(/query parameter/);
  });

  it('allows harmless query parameters on a local URL', () => {
    expect(assertSeedTarget(`${urlFor('localhost')}?sslmode=disable&application_name=seed`, {}).host).toBe('localhost');
  });

  it('never leaks the password or user name when it refuses an overriding query parameter', () => {
    for (const query of ['?host=remote.example', '?hostaddr=203.0.113.9', '?service=prod']) {
      let message = '';
      try {
        assertSeedTarget(`${urlFor('localhost')}${query}`, {});
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(PASSWORD);
      expect(message).not.toContain('planner_user');
      expect(message).not.toContain('remote.example');
    }
  });

  it('never exposes the password or the user name, in the summary or in any error', () => {
    const messages: string[] = [];
    for (const env of [{}, { PLANNER_SEED_ALLOW_HOST: 'other.example.test' }, { NODE_ENV: 'production' }]) {
      try {
        assertSeedTarget(urlFor(HOSTED), env);
      } catch (error) {
        messages.push((error as Error).message);
      }
    }
    expect(messages).toHaveLength(3);
    const summary = assertSeedTarget(urlFor(HOSTED), { PLANNER_SEED_ALLOW_HOST: HOSTED });
    for (const text of [...messages, ...Object.values(summary), JSON.stringify(summary)]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain('planner_user');
    }
  });
});
