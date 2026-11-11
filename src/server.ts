import { createApp } from "./app";
import { config } from "./config";
import { pool } from "./db";
import { logger } from "./lib/logger";

const server = createApp().listen(config.PORT, () => {
  logger.info(`API listening on http://localhost:${config.PORT}/api`);
});

// Close cleanly when the process is asked to stop (Ctrl+C, systemd restart, deploy).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
