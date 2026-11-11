import pino from "pino";
import { config } from "../config";

// One shared logger. Pretty-printed in development, plain JSON (for log shipping) in production.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    config.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
});
