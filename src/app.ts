import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { sql } from "drizzle-orm";
import "./lib/bigint"; // makes BigInt ids JSON-serializable
import { config } from "./config";
import { db } from "./db";
import { HttpError } from "./lib/errors";
import { logger } from "./lib/logger";
import { ok } from "./lib/respond";
import { errorHandler } from "./middleware/errorHandler";
import { publicAuthRouter } from "./modules/auth/auth.routes";
import { authenticate } from "./middleware/authenticate";
import { privateAuthRouter } from "./modules/auth/auth.routes";
import { docsEnabled, docsRouter } from "./docs/docs.routes";
import { membersRouter } from "./modules/members/members.routes";
import { organizationsRouter } from "./modules/organizations/organizations.routes";
import { permissionsRouter, rolesRouter } from "./modules/roles/roles.routes";
import { staffRouter } from "./modules/staff/staff.routes";
import { subjectsRouter } from "./modules/subjects/subjects.routes";
import { classesRouter, sectionsRouter } from "./modules/classes/classes.routes";
import { sectionTeachersRouter, timeSlotsRouter, timetableRouter } from "./modules/timetable/timetable.routes";
import { homeworkRouter, homeworkSubmissionsRouter } from "./modules/homework/homework.routes";
import {
  driversRouter,
  pickupPointsRouter,
  routeSchedulesRouter,
  transportAssignmentsRouter,
  transportRoutesRouter,
  vehiclesRouter,
} from "./modules/transport/transport.routes";
import {
  assetAllocationsRouter,
  assetCategoriesRouter,
  assetMaintenanceRouter,
  assetsRouter,
} from "./modules/assets/assets.routes";
import { admissionsRouter } from "./modules/admissions/admissions.routes";
import { guardiansRouter, studentHousesRouter, studentsRouter } from "./modules/students/students.routes";
// Building the app in a function (instead of starting the server here) lets tests use it too.
// The ORDER of the lines below is the security design: Express runs them top to bottom.
export function createApp() {
  const app = express();

  app.set("trust proxy", 1); // behind nginx later: makes req.ip the real client address
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGINS?.split(",") ?? false }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === "/api/health" }, // the health check runs every few seconds; don't flood the log
      customProps: (req) => ({ tenantId: req.tenant?.id?.toString() }), // set once authenticate() runs; undefined on public routes
    }),
  );
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser()); // makes req.cookies available
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 100,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  ); // 100 req/min/IP

  // ---- API documentation: /api/docs (Swagger UI) and /api/openapi.json. Public, so BEFORE authenticate; off in production. ----
  if (docsEnabled) app.use("/api", docsRouter());

  // ---- PUBLIC routes (registered BEFORE authenticate, which you add in C8) ----
  app.get("/api/health", async (_req, res) => {
    await db.execute(sql`SELECT 1`); // proves the database connection works
    ok(res, { status: "ok" });
  });

  // ---- UNCOMMENT each line when its chapter's code is finished (and add the imports at the top) ----
  app.use("/api/auth", publicAuthRouter); // signup, login, refresh, logout  (public)
app.use("/api", authenticate); // THE DIVIDING LINE: everything below needs a signed-in person
  app.use("/api/auth", privateAuthRouter); // me, switch-organization
  app.use("/api/organizations", organizationsRouter);
  app.use("/api/members", membersRouter);
  app.use("/api/roles", rolesRouter);
  app.use("/api/permissions", permissionsRouter);
  app.use("/api/staff", staffRouter);
  app.use("/api/subjects", subjectsRouter);
  app.use("/api/classes", classesRouter);
app.use("/api/sections", sectionsRouter);
app.use("/api/time-slots", timeSlotsRouter);
app.use("/api/section-teachers", sectionTeachersRouter);
app.use("/api/timetable", timetableRouter);
app.use("/api/homework", homeworkRouter);
app.use("/api/homework-submissions", homeworkSubmissionsRouter);
app.use("/api/vehicles", vehiclesRouter);
app.use("/api/drivers", driversRouter);
app.use("/api/transport-routes", transportRoutesRouter);
app.use("/api/pickup-points", pickupPointsRouter);
app.use("/api/route-schedules", routeSchedulesRouter);
app.use("/api/transport-assignments", transportAssignmentsRouter);
app.use("/api/asset-categories", assetCategoriesRouter);
app.use("/api/assets", assetsRouter);
  app.use("/api/asset-allocations", assetAllocationsRouter);
  app.use("/api/asset-maintenance", assetMaintenanceRouter);
  app.use("/api/admissions", admissionsRouter);
  app.use("/api/students", studentsRouter);
  app.use("/api/guardians", guardiansRouter);
  app.use("/api/student-houses", studentHousesRouter);

  app.use((_req, _res, next) => next(new HttpError(404, "Not found"))); // nothing matched
  app.use(errorHandler); // must be the very last line
  return app;
}
