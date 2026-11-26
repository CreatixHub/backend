import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "../../config";
import { db } from "../../db";
import { refreshTokens } from "../../db/schema";
import { sha256 } from "../../lib/hash";
import { created, ok } from "../../lib/respond";
import type { TenantContext } from "../../lib/tenant";

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

// ---- B1: Mobile Client Detection ----
// A mobile client identifies itself with the `X-Client: mobile` header.
// This is NOT an authentication mechanism; it only controls the token delivery strategy.
export function isMobileClient(req: Request): boolean {
  return req.get("x-client")?.toLowerCase() === "mobile";
}

// The access token says WHO the person is and which school they are acting in (tid). Absent tid = no school yet.
export function signAccessToken(userId: bigint, tenantId: bigint | null): string {
  return jwt.sign(
    { sub: String(userId), ...(tenantId ? { tid: String(tenantId) } : {}) },
    config.JWT_ACCESS_SECRET,
    { algorithm: "HS256", expiresIn: config.JWT_ACCESS_TTL, jwtid: randomUUID() },
  );
}

// One login = one chain ("family") of refresh tokens. Each refresh adds a new row to the same family.
export async function createSession(args: {
  userId: bigint;
  tenantId: bigint | null;
  meta: ClientMeta;
  familyId?: string;
}) {
  const refreshToken = randomBytes(48).toString("base64url");
  await db.insert(refreshTokens).values({
    userId: args.userId,
    tenantId: args.tenantId,
    familyId: args.familyId ?? randomUUID(),
    tokenHash: sha256(refreshToken), // only the hash is stored
    userAgent: args.meta.userAgent?.slice(0, 300),
    ip: args.meta.ip,
    expiresAt: new Date(Date.now() + config.REFRESH_TTL_DAYS * 86_400_000),
  });
  return { accessToken: signAccessToken(args.userId, args.tenantId), refreshToken };
}

const cookieOptions = {
  httpOnly: true, // JavaScript on the page cannot read it
  secure: config.COOKIE_SECURE, // true in production over HTTPS
  sameSite: "lax" as const,
  path: "/api/auth", // the browser sends it only to /api/auth/* routes
};

export function setRefreshCookie(res: Response, token: string) {
  res.cookie("rt", token, { ...cookieOptions, maxAge: config.REFRESH_TTL_DAYS * 86_400_000 });
}

export function clearRefreshCookie(res: Response) {
  res.clearCookie("rt", cookieOptions); // the path must match the one used to set it
}

const ROLE_PRIORITY = [
  "teacher", "accountant", "librarian", "receptionist", "warden",
  "transport_manager", "nurse", "security", "parent", "student",
];

// Your frontend has ONE role per user (it picks the home dashboard from it). We compute it from the
// person's roles in the active school.
export function toFrontendRole(roleCodes: string[]): string | null {
  if (roleCodes.length === 0) return null;
  if (roleCodes.includes("owner") || roleCodes.includes("admin")) return "admin";
  return ROLE_PRIORITY.find((r) => roleCodes.includes(r)) ?? "receptionist"; // unknown custom role: neutral staff role
}

// The user JSON your frontend's auth.http.ts reads.
export function toFrontendUser(
  user: {
    id: bigint;
    username: string | null;
    fullName: string;
    email: string | null;
    phone: string | null;
    avatarUrl: string | null;
    avatarFileId: bigint | null;
    languageId: bigint | null;
    timezone: string | null;
    preferences: Record<string, unknown>;
    userType: string;
    status: string;
    mustChangePassword: boolean;
    mfaEnabled: boolean;
  },
  tenant: TenantContext | null,
) {
  return {
    id: user.id,
    username: user.username,
    name: user.fullName,
    email: user.email,
    role: tenant ? toFrontendRole(tenant.roles) : null,
    userType: user.userType,
    status: user.status,
    permissions: !tenant ? [] : tenant.permissions.has("*") ? ["*"] : [...tenant.permissions].sort(),
    avatar: user.avatarUrl,
    avatarFileId: user.avatarFileId,
    phone: user.phone,
    languageId: user.languageId,
    timezone: user.timezone,
    preferences: user.preferences,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled: user.mfaEnabled,
    organization: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name, roles: tenant.roles } : null,
  };
}

// Sets the refresh cookie (web) or includes the refresh token in JSON (mobile), then sends the session payload.
export function sendSession(
  res: Response,
  status: 200 | 201,
  p: {
    session: { accessToken: string; refreshToken: string };
    user: Parameters<typeof toFrontendUser>[0];
    tenant: TenantContext | null;
    organizations: unknown[];
  },
  mobile = false,
) {
  const data: Record<string, unknown> = {
    accessToken: p.session.accessToken,
    expiresIn: config.JWT_ACCESS_TTL,
    user: toFrontendUser(p.user, p.tenant),
    organizations: p.organizations,
  };

  if (mobile) {
    // B2: Mobile clients cannot use httpOnly cookies; return the refresh token in the JSON body.
    data.refreshToken = p.session.refreshToken;
  } else {
    // Web: the refresh token goes ONLY in the httpOnly cookie, never in the JSON body.
    setRefreshCookie(res, p.session.refreshToken);
  }

  if (status === 201) created(res, data);
  else ok(res, data);
}
