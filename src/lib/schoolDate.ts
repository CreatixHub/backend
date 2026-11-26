import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';
import { todayInTimezone } from './dates';
import type { TenantContext } from './tenant';

export async function schoolToday(tenant: TenantContext): Promise<string> {
  const [org] = await db
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, tenant.id))
    .limit(1);
  return todayInTimezone(org?.timezone || 'UTC');
}
