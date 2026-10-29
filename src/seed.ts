import { PrismaClient } from '@prisma/client';
import { PERMISSIONS } from './permissions';

const prisma = new PrismaClient();

// Loads the permission catalogue into the database. Safe to run many times (upsert), and you re-run it
// whenever you add a permission to src/permissions.ts.
//   Development:  npx prisma db seed      Production (compiled):  node dist/seed.js
async function main() {
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      update: { module: p.module, action: p.action, description: p.description },
      create: { code: p.code, module: p.module, action: p.action, description: p.description },
    });
  }
  console.log(`Seeded ${PERMISSIONS.length} permissions.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
