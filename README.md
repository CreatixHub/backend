# Karkaii API (backend)

Multi-school ERP backend. Node.js 22 + Express 5 + TypeScript + Prisma 6 + PostgreSQL.

**This is not a starter kit anymore** — auth, multi-tenancy (one account, many schools) and role/permission
checks are already built and working. If you're new to this stack, read this file top to bottom before
touching code; it explains the *why*, not just the *how*.

## 1. What this backend actually does

One person signs up once. They can belong to several schools ("organizations" in the code) with a
**different role in each one** — owner in one, teacher in another. Every request is checked against that
person's permissions **in the school they're currently acting as**. That's the one idea the whole auth layer
exists to support — keep it in mind and the rest of this doc makes sense.

| Term in the code | What it means in plain words |
|---|---|
| `User` | A person. One row, one login, used across every school they belong to. |
| `Organization` | A school/tenant. Data never leaks between organizations. |
| `Membership` | "This user belongs to this school" — the join between the two. |
| `Role` / `Permission` | What a membership is allowed to do (`students.read`, `fees.write`, …). |
| `RefreshToken` | One row per active login session (see the JWT section below). |

## 2. Tech stack, and why each piece is there

| Piece | Library | Why |
|---|---|---|
| HTTP server | Express 5 | Minimal, everyone's seen it before, easy to reason about top-to-bottom. |
| Language | TypeScript | Catches "undefined is not a function" at compile time, not in production. |
| Database | PostgreSQL 16 (Docker locally) | Relational — schools/users/roles are inherently relational data. |
| ORM | Prisma 6 | **Being migrated to Drizzle ORM** — see the note below. Don't learn Prisma's schema syntax deeply. |
| Passwords | `argon2` | The current best-practice password hash (not bcrypt, not plain SHA). |
| Access tokens | `jsonwebtoken` (JWT) | Short-lived, stateless, verified without hitting the DB for the signature itself. |
| Validation | `zod` | Every request body is parsed through a schema before it touches business logic. |
| Security headers / CORS / rate limiting | `helmet`, `cors`, `express-rate-limit` | Baseline hardening, applied once in `app.ts`. |
| API docs | `swagger-ui-express` + `zod-to-openapi` | `/api/docs` — live, generated from the same Zod schemas that validate requests. |

> **Heads up — ORM migration in progress.** The 9-table auth/tenant foundation below is still on Prisma, but
> the project is moving to **Drizzle ORM** before the rest of the modules (students, fees, timetable, …) get
> built. If you're starting fresh, ask what the current state of that migration is before writing new
> `prisma/schema.prisma` models — you may be working in Drizzle already by the time you read this.

## 3. Project layout

```
src/
  app.ts                     — builds the Express app (routes are wired here, in a deliberate order)
  server.ts                  — actually starts the HTTP listener (app.ts is imported by tests too)
  config.ts                  — reads and validates .env with zod; crashes on boot if something's missing
  db.ts                      — the single shared Prisma client
  seed.ts                    — creates one demo school + demo login for local testing
  middleware/
    authenticate.ts          — turns "Authorization: Bearer <token>" into req.user / req.tenant
    requirePermission.ts     — route guard: 403s if the caller's role lacks a given permission
    errorHandler.ts          — the last middleware; turns thrown errors into a consistent JSON shape
  modules/
    auth/                    — signup, login, refresh, logout, /me, switch-organization (see §5)
    organizations/           — create/list/switch schools
    members/                 — add/remove people from a school, change their role
    roles/                   — roles.routes.ts also serves /api/permissions
  lib/
    tenant.ts                — loads "this user's roles+permissions in this school" (the core tenancy logic)
    errors.ts, respond.ts    — HttpError class + consistent { data } / { error } response envelope
    hash.ts                  — sha256 helper used to hash refresh tokens before they're stored
  docs/                       — OpenAPI generation + Swagger UI wiring (not the same as the top-level docs/ folder)
prisma/
  schema.prisma, migrations/ — the 9-table auth/tenant schema (see the ORM note above)
docs/                         — design docs, the ERD, and this backend's generated API reference PDFs
```

**Read the files in this order** if you're onboarding: `config.ts` → `app.ts` → `middleware/authenticate.ts` →
`modules/auth/session.ts` → `modules/auth/auth.service.ts` → `lib/tenant.ts`. That's the whole security model.

## 4. Getting it running locally

1. Install **Node 22** and **Docker**.
2. From this folder:
   ```bash
   npm install
   docker compose up -d                 # starts local PostgreSQL on :5432 (container: karkaii-pg)
   cp env.template .env
   ```
3. Open `.env` and replace `JWT_ACCESS_SECRET` with a real secret:
   ```bash
   openssl rand -hex 32
   ```
   Paste the output in. **Never reuse the placeholder value** and never commit `.env`.
4. Create the database tables and seed a demo account:
   ```bash
   npm run db:migrate
   npm run db:seed
   ```
5. Start the API:
   ```bash
   npm run dev
   ```
6. Confirm it's alive: open http://localhost:5000/api/health — you should see `{"data":{"status":"ok"}}`.
   If this 500s, Postgres isn't running — check `docker ps` for `karkaii-pg` and `docker start karkaii-pg` if
   it's stopped (it does **not** auto-restart after a reboot).
7. Try logging in with the seeded demo account (see `src/seed.ts` for the exact email/password) against
   `POST /api/auth/login`, or open http://localhost:5000/api/docs for a live, click-to-try API explorer.

## 5. The JWT / session flow

The short version: **access tokens are JWTs, refresh tokens are not.**

- **Access token** — a signed JWT (`{ sub: userId, tid: organizationId }`), lives **15 minutes**, sent as
  `Authorization: Bearer <token>` on every request, verified without a database round-trip for its signature
  (though the user is still re-loaded from the DB on every request, so disabling someone takes effect
  immediately).
- **Refresh token** — a random 48-byte value, lives **30 days**, sent only as an `httpOnly` cookie scoped to
  `/api/auth/*` (JavaScript on the page can never read it). Only its SHA-256 hash is ever stored in the
  database. Each time it's used, it's **rotated**: the old one is marked used and a brand-new one takes its
  place in the same "family" (login chain). If an already-used refresh token is ever presented again, that's
  treated as **theft** and the entire family is revoked — forcing a real re-login.

Full lifecycle — login, using a token, refreshing, logout, and the theft-detection path — is diagrammed below
(also at `docs/jwt-flow-diagram.png`, and as a detailed step-by-step sequence diagram in
`docs/LOGIN-AND-TOKEN-FLOWS.pdf`):

![JWT and refresh-token lifecycle](docs/jwt-flow-diagram.png)

The code for all of this lives in exactly four files: `modules/auth/session.ts` (sign/verify, cookies),
`modules/auth/auth.service.ts` (the login/refresh/logout business logic), `modules/auth/auth.routes.ts` (the
6 HTTP endpoints), `middleware/authenticate.ts` (the check every protected route goes through).

## 6. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts the API with auto-restart on file changes. |
| `npm run build` / `npm start` | Compiles to `dist/` and runs the compiled JS (what production runs). |
| `npm run typecheck` | TypeScript check with no build output — run this before committing. |
| `npm test` | Runs the Vitest suite. |
| `npm run db:migrate` | Applies Prisma migrations to your local database. |
| `npm run db:seed` | Re-runs `src/seed.ts` (idempotent — safe to run again). |
| `npm run db:studio` | Opens Prisma Studio, a GUI for browsing the local database. |

## 7. Where to go next

- `docs/karkaii-erd-updated.drawio` — the full entity-relationship diagram (open at diagrams.net / draw.io).
- `docs/BACKEND-OVERVIEW.pdf` — a snapshot of what's built so far (status, endpoint count, test results).
- `docs/HTTPIE-COMMANDS.md` / `docs/HTTPIE-SESSIONS-GUIDE.pdf` — how to call the API by hand from a terminal.
- The project-wide onboarding doc your team lead shared alongside this README covers the **14 modules**
  being built next (Admission, Students, Staff, Fees, Timetable, …) and the exact database fields for each.

## 8. Rules

- Never commit `.env` or anything containing a real database password or JWT secret.
- Keep dependency versions as they are in `package.json`; upgrade one library at a time, deliberately.
- Run `npm run typecheck` and `npm test` before opening a PR.
