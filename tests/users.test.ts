import request from 'supertest';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db';
import { users } from '../src/db/schema';
import { app, signupAndLogin, uniqueEmail, uniqueSlug, VALID_PASSWORD } from './helpers';

const uniqueUsername = (tag: string) => `${tag}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

describe('users enhancement (PDF Section 6)', () => {
  it('supports extended user fields on signup, /me and login by username without exposing sensitive columns', async () => {
    const email = uniqueEmail('usr-ext');
    const username = uniqueUsername('usr');

    const signup = await request(app).post('/api/auth/signup').send({
      fullName: 'Priya Menon',
      email,
      username,
      phone: '9876543210',
      password: VALID_PASSWORD,
      userType: 'admin',
      timezone: 'Asia/Kolkata',
      languageId: '1',
      avatarFileId: '1',
      preferences: { theme: 'light', compactSidebar: true },
    });

    expect(signup.status).toBe(201);
    const u = signup.body.data.user;
    expect(u.username).toBe(username);
    expect(u.email).toBe(email);
    expect(u.phone).toBe('9876543210');
    expect(u.userType).toBe('admin');
    expect(u.status).toBe('active');
    expect(u.timezone).toBe('Asia/Kolkata');
    expect(u.languageId).toBe('1');
    expect(u.avatarFileId).toBe('1');
    expect(u.preferences).toEqual({ theme: 'light', compactSidebar: true });
    expect(u.mustChangePassword).toBe(false);
    expect(u.mfaEnabled).toBe(false);

    // Sensitive fields must never leak in API JSON
    const rawSignup = JSON.stringify(signup.body);
    expect(rawSignup).not.toContain('passwordHash');
    expect(rawSignup).not.toContain('password_hash');
    expect(rawSignup).not.toContain('failedLoginCount');
    expect(rawSignup).not.toContain('lockedUntil');

    // Login using username instead of email
    const loginByUsername = await request(app).post('/api/auth/login').send({
      username,
      password: VALID_PASSWORD,
    });
    expect(loginByUsername.status).toBe(200);
    expect(loginByUsername.body.data.user.username).toBe(username);
    expect(JSON.stringify(loginByUsername.body)).not.toContain('passwordHash');

    // /me returns the extended user fields
    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${loginByUsername.body.data.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.username).toBe(username);
    expect(me.body.data.timezone).toBe('Asia/Kolkata');

    // Verify DB recorded lastLoginAt and lastLoginIp
    const [dbUser] = await db.select().from(users).where(eq(users.id, BigInt(u.id))).limit(1);
    expect(dbUser.lastLoginAt).toBeInstanceOf(Date);
    expect(dbUser.lastLoginIp).toBeTruthy();
    expect(dbUser.failedLoginCount).toBe(0);
  });

  it('enforces unique username constraint', async () => {
    const username = uniqueUsername('dup_u');
    const r1 = await request(app).post('/api/auth/signup').send({
      fullName: 'First User',
      email: uniqueEmail('u1'),
      username,
      password: VALID_PASSWORD,
    });
    expect(r1.status).toBe(201);

    const r2 = await request(app).post('/api/auth/signup').send({
      fullName: 'Second User',
      email: uniqueEmail('u2'),
      username,
      password: VALID_PASSWORD,
    });
    expect(r2.status).toBe(409);
  });

  it('tracks failed login attempts, locks after 5 failures and resets on expiry/success', async () => {
    const email = uniqueEmail('lock');
    const signup = await request(app).post('/api/auth/signup').send({
      fullName: 'Lock Test',
      email,
      password: VALID_PASSWORD,
    });
    expect(signup.status).toBe(201);
    const userId = BigInt(signup.body.data.user.id);

    for (let i = 1; i <= 5; i++) {
      const bad = await request(app).post('/api/auth/login').send({ email, password: 'wrong-password' });
      expect(bad.status).toBe(401);
      expect(bad.body.message).toBe('Invalid email or password');
    }

    const [lockedRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(lockedRow.failedLoginCount).toBe(5);
    expect(lockedRow.lockedUntil).toBeInstanceOf(Date);
    expect(lockedRow.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Even the right password is rejected with generic 401 while locked
    const blocked = await request(app).post('/api/auth/login').send({ email, password: VALID_PASSWORD });
    expect(blocked.status).toBe(401);
    expect(blocked.body.message).toBe('Invalid email or password');

    // Once lock window expires, valid login succeeds and resets failedLoginCount & lockedUntil
    await db.update(users).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, userId));
    const okLogin = await request(app).post('/api/auth/login').send({ email, password: VALID_PASSWORD });
    expect(okLogin.status).toBe(200);

    const [resetRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    expect(resetRow.failedLoginCount).toBe(0);
    expect(resetRow.lockedUntil).toBeNull();
  });

  it('supports invited users (nullable passwordHash), userType inference and search by username via members', async () => {
    const { agent, switchOrganization } = await signupAndLogin('usr-mem');
    const slug = uniqueSlug('usr-mem');
    await agent.post('/api/organizations').send({ name: 'Members User School', slug });
    await switchOrganization(slug);

    const inviteEmail = uniqueEmail('invited');
    const inviteUsername = uniqueUsername('inv');
    const inviteRes = await agent.post('/api/members').send({
      email: inviteEmail,
      username: inviteUsername,
      fullName: 'Invited Parent',
      phone: '9000011111',
      invite: true,
      roles: ['parent'],
    });

    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.data.username).toBe(inviteUsername);
    expect(inviteRes.body.data.userType).toBe('guardian');
    expect(inviteRes.body.data.userStatus).toBe('invited');
    expect(inviteRes.body.data.invitedAt).toBeTruthy();

    // Invited user without passwordHash cannot log in
    const loginAttempt = await request(app).post('/api/auth/login').send({
      email: inviteEmail,
      password: VALID_PASSWORD,
    });
    expect(loginAttempt.status).toBe(401);

    // Search members by username
    const searchRes = await agent.get(`/api/members?q=${inviteUsername}`);
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.data).toHaveLength(1);
    expect(searchRes.body.data[0].username).toBe(inviteUsername);
  });

  it('supports nullable email, nullable passwordHash and self-referencing deletedBy FK in PostgreSQL', async () => {
    const [adminActor] = await db
      .insert(users)
      .values({
        username: uniqueUsername('actor'),
        fullName: 'Deleting Admin',
        userType: 'admin',
        status: 'active',
      })
      .returning();

    const [usernameOnlyUser] = await db
      .insert(users)
      .values({
        username: uniqueUsername('stu_portal'),
        email: null,
        fullName: 'Student Portal User',
        passwordHash: null,
        userType: 'student',
        status: 'deleted',
        deletedAt: new Date(),
        deletedBy: adminActor.id,
      })
      .returning();

    expect(usernameOnlyUser.email).toBeNull();
    expect(usernameOnlyUser.passwordHash).toBeNull();
    expect(usernameOnlyUser.deletedBy).toBe(adminActor.id);
    expect(usernameOnlyUser.preferences).toEqual({});
    expect(usernameOnlyUser.mustChangePassword).toBe(false);
    expect(usernameOnlyUser.mfaEnabled).toBe(false);
  });
});
