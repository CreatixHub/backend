import { createApp } from './app';
import { config } from './config';
import { prisma } from './db';

const server = createApp().listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT}/api`);
});

// Close cleanly when the process is asked to stop (Ctrl+C, systemd restart, deploy).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  });
}
