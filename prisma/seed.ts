import { PrismaClient } from '@prisma/client';
import { PERMISSIONS } from '../src/permissions';

const prisma = new PrismaClient();

// Loads the permission catalogue into the database. Safe to run many times (upsert), and you re-run it
// whenever you add a permission to src/permissions.ts.   Run:  npx prisma db seed
async function main() {
  // TODO: for (const p of PERMISSIONS) await prisma.permission.upsert({
  //         where: { code: p.code },
  //         update: { module: p.module, action: p.action, description: p.description },
  //         create: { code: p.code, module: p.module, action: p.action, description: p.description } })
  console.log(`Seeded ${PERMISSIONS.length} permissions.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
