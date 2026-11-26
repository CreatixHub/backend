import { createApp } from "./app";
import { config } from "./config";
import { pool } from "./db";
import { logger } from "./lib/logger";

const server = createApp().listen(config.PORT, "0.0.0.0", () => {
  logger.info(`API listening on port ${config.PORT}`);
  logger.info(`Local API: http://localhost:${config.PORT}/api`);
});

// Graceful shutdown
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}