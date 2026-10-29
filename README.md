# Karkaii API - starter

Node.js (Express 5) + TypeScript + Prisma 6 + PostgreSQL.

This is an **empty starter**: the project, libraries (tested versions), TypeScript config, .gitignore and a local
PostgreSQL compose file are ready. **You write the backend yourself**, following the guide.

Open **docs/Karkaii-Backend-Guide.pdf** (the 20-hour plan):

1. Chapter 0 - the plan and the changes since the earlier guide.
2. **Part A** - fast-track learning (Node.js, TypeScript, Express, Prisma, cookies/tokens). Put exercises in `exercises/`.
3. **Part B** - the design (tenants, memberships, sessions, roles).
4. **Part C** - the build. **C0** sets up your DigitalOcean database and a local one.

## First 10 minutes

1. Install **Node 22 LTS** (`node -v`) and **Docker**.
2. In this folder:
   ```
   npm install
   npm i cookie-parser && npm i -D @types/cookie-parser     # one extra library the guide needs
   docker compose up -d                                      # local PostgreSQL on port 5432
   cp env.template .env                                      # then set JWT_ACCESS_SECRET (openssl rand -hex 32)
   ```
3. Check the placeholder server: `npm run dev`, open http://localhost:5000/api/health. Stop with Ctrl+C.
4. Start with chapter C0 of the guide (DigitalOcean database), then Part A.

## What is where

| Path | What |
|---|---|
| docs/Karkaii-Backend-Guide.pdf | the guide |
| docs/karkaii-erd-updated.drawio | the ERD (open at diagrams.net). The guide explains what to change in it |
| exercises/ | your Part A practice files |
| src/server.ts | placeholder; you replace it while following Part C |
| prisma/ | schema, seed and migrations go here (empty) |
| env.template | copy to `.env` - **never commit .env** (or `.env.do` with your DigitalOcean URL) |

## Scripts

`npm run dev` (auto-restart) - `npm run build` - `npm start` - `npm run typecheck` - `npm run db:migrate` -
`npm run db:seed` - `npm run db:studio`

## Rules

- Never commit `.env` or any file containing a database password.
- Keep the package versions as they are; upgrade libraries later, one at a time.
- When you push to GitHub, create a new empty repo for this folder.
# backend
