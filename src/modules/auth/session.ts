import type { Response } from "express";
import jwt from "jsonwebtoken";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "../../config";
import { prisma } from "../../db";
import { sha256 } from "../../lib/hash";
import { created, ok } from "../../lib/respond";
import type { TenantContext } from "../../lib/tenant";

export interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

// The access token says WHO the person is and which school they are acting in (tid). Absent tid = no school yet.
export function signAccessToken(userId: bigint, tenantId: bigint | null): string {
  return jwt.sign(
    { sub: String(userId), ...(tenantId ? { tid: String(tenantId) } : {}) },
    config.JWT_ACCESS_SECRET,
    { algorithm: "HS256", expiresIn: config.JWT_ACCESS_TTL },
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
  await prisma.refreshToken.create({
    data: {
      userId: args.userId,
      tenantId: args.tenantId,
      familyId: args.familyId ?? randomUUID(),
      tokenHash: sha256(refreshToken), // only the hash is stored
      userAgent: args.meta.userAgent?.slice(0, 300),
      ip: args.meta.ip,
      expiresAt: new Date(Date.now() + config.REFRESH_TTL_DAYS * 86_400_000),
    },
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
  user: { id: bigint; fullName: string; email: string; phone: string | null; avatarUrl: string | null },
  tenant: TenantContext | null,
) {
  return {
    id: user.id,
    name: user.fullName,
    email: user.email,
    role: tenant ? toFrontendRole(tenant.roles) : null,
    permissions: !tenant ? [] : tenant.permissions.has("*") ? ["*"] : [...tenant.permissions].sort(),
    avatar: user.avatarUrl,
    phone: user.phone,
    organization: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name, roles: tenant.roles } : null,
  };
}

// Sets the refresh cookie, then sends { accessToken, expiresIn, user, organizations } in the usual envelope.
export function sendSession(
  res: Response,
  status: 200 | 201,
  p: {
    session: { accessToken: string; refreshToken: string };
    user: Parameters<typeof toFrontendUser>[0];
    tenant: TenantContext | null;
    organizations: unknown[];
  },
) {
  setRefreshCookie(res, p.session.refreshToken);
  const data = {
    accessToken: p.session.accessToken,
    expiresIn: config.JWT_ACCESS_TTL,
    user: toFrontendUser(p.user, p.tenant),
    organizations: p.organizations,
  };
  // The refresh token goes ONLY in the cookie, never in this JSON.
  if (status === 201) created(res, data);
  else ok(res, data);
}
