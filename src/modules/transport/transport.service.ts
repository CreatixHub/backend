import { and, asc, count, eq, getTableColumns, gte, ilike, isNull, lte, ne, or } from 'drizzle-orm';
import { db } from '../../db';
import {
  drivers,
  pickupPoints,
  routeSchedules,
  staff,
  transportAssignments,
  transportRoutes,
  vehicles,
} from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { resolveStudentScope, studentScopeCondition } from '../../lib/ownership';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';
import type {
  CreateAssignmentInput,
  CreateDriverInput,
  CreatePickupPointInput,
  CreateRouteInput,
  CreateScheduleInput,
  CreateVehicleInput,
  ListAssignmentsInput,
  ListDriversInput,
  ListPickupPointsInput,
  ListRoutesInput,
  ListSchedulesInput,
  ListVehiclesInput,
  UpdateAssignmentInput,
  UpdateDriverInput,
  UpdatePickupPointInput,
  UpdateRouteInput,
  UpdateScheduleInput,
  UpdateVehicleInput,
} from './transport.schemas';

// RULES (same as the other modules): every query has tenantId = tenant.id.
// The students table does not exist yet, so a studentId is NOT checked. Staff riders are.

const UNIQUE_VIOLATION = '23505';
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === UNIQUE_VIOLATION;
}

const toRow = (row: object) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'tenantId'));

interface Page {
  rows: unknown[];
  meta: { page: number; limit: number; total: number; pages: number };
}
const pageMeta = (page: number, limit: number, total: number) => ({ page, limit, total, pages: Math.ceil(total / limit) });

// dates are compared as YYYY-MM-DD text (UTC)
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysFromToday = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const notFound = <T>(row: T | undefined, message: string): T => {
  if (!row) throw new HttpError(404, message);
  return row;
};
const must = <T>(row: T | undefined, message: string): T => {
  if (!row) throw new HttpError(400, message);
  return row;
};

// ---------------------------------------------------------------- finders (tenant-scoped, return undefined when missing)
const findVehicle = async (tenantId: bigint, id: bigint) =>
  (await db.select().from(vehicles).where(and(eq(vehicles.id, id), eq(vehicles.tenantId, tenantId))).limit(1))[0];

const findDriver = async (tenantId: bigint, id: bigint) =>
  (await db.select().from(drivers).where(and(eq(drivers.id, id), eq(drivers.tenantId, tenantId))).limit(1))[0];

const findRoute = async (tenantId: bigint, id: bigint) =>
  (
    await db
      .select()
      .from(transportRoutes)
      .where(and(eq(transportRoutes.id, id), eq(transportRoutes.tenantId, tenantId)))
      .limit(1)
  )[0];

const findPickupPoint = async (tenantId: bigint, id: bigint) =>
  (
    await db
      .select()
      .from(pickupPoints)
      .where(and(eq(pickupPoints.id, id), eq(pickupPoints.tenantId, tenantId)))
      .limit(1)
  )[0];

const findSchedule = async (tenantId: bigint, id: bigint) =>
  (
    await db
      .select()
      .from(routeSchedules)
      .where(and(eq(routeSchedules.id, id), eq(routeSchedules.tenantId, tenantId)))
      .limit(1)
  )[0];

const findAssignment = async (tenantId: bigint, id: bigint) =>
  (
    await db
      .select()
      .from(transportAssignments)
      .where(and(eq(transportAssignments.id, id), eq(transportAssignments.tenantId, tenantId)))
      .limit(1)
  )[0];

async function assertStaff(tenantId: bigint, staffId: bigint, mustBeActive: boolean) {
  const [row] = await db
    .select({ id: staff.id, status: staff.status })
    .from(staff)
    .where(and(eq(staff.id, staffId), eq(staff.tenantId, tenantId), isNull(staff.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(400, 'Staff member not found in this school');
  if (mustBeActive && row.status !== 'active') throw new HttpError(400, 'That staff member is not active');
}

// Schedules that are still running or start in the future for a vehicle / driver.
async function countCurrentSchedules(tenantId: bigint, who: 'vehicle' | 'driver', id: bigint): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(routeSchedules)
    .where(
      and(
        eq(routeSchedules.tenantId, tenantId),
        eq(who === 'vehicle' ? routeSchedules.vehicleId : routeSchedules.driverId, id),
        gte(routeSchedules.validTo, todayStr()),
      ),
    );
  return total;
}

// ================================================================ VEHICLES
const REG_TAKEN = 'That registration number is already used in this school';

export async function listVehicles(tenant: TenantContext, q: ListVehiclesInput): Promise<Page> {
  const limitDate = q.expiringWithinDays ? daysFromToday(q.expiringWithinDays) : undefined;
  const where = and(
    eq(vehicles.tenantId, tenant.id),
    q.vehicleType ? eq(vehicles.vehicleType, q.vehicleType) : undefined,
    q.status ? eq(vehicles.status, q.status) : undefined,
    q.q
      ? or(ilike(vehicles.registrationNo, `%${q.q}%`), ilike(vehicles.make, `%${q.q}%`), ilike(vehicles.model, `%${q.q}%`))
      : undefined,
    limitDate
      ? and(
          ne(vehicles.status, 'retired'),
          or(
            lte(vehicles.insuranceExpiry, limitDate),
            lte(vehicles.fitnessExpiry, limitDate),
            lte(vehicles.permitExpiry, limitDate),
            lte(vehicles.pollutionExpiry, limitDate),
          ),
        )
      : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(vehicles)
      .where(where)
      .orderBy(asc(vehicles.registrationNo))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(vehicles).where(where),
  ]);
  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, total) };
}

export async function getVehicle(tenant: TenantContext, id: bigint): Promise<unknown> {
  return toRow(notFound(await findVehicle(tenant.id, id), 'Vehicle not found'));
}

export async function createVehicle(tenant: TenantContext, _actor: AuthUser, input: CreateVehicleInput): Promise<unknown> {
  try {
    const [row] = await db
      .insert(vehicles)
      .values({ ...input, tenantId: tenant.id })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, REG_TAKEN);
    throw e;
  }
}

export async function updateVehicle(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateVehicleInput,
): Promise<unknown> {
  const existing = notFound(await findVehicle(tenant.id, id), 'Vehicle not found');
  if (input.status === 'retired' && existing.status !== 'retired') {
    if ((await countCurrentSchedules(tenant.id, 'vehicle', id)) > 0) {
      throw new HttpError(409, 'Remove this vehicle from its route schedules first');
    }
  }
  try {
    const [row] = await db
      .update(vehicles)
      .set(input)
      .where(and(eq(vehicles.id, id), eq(vehicles.tenantId, tenant.id)))
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, REG_TAKEN);
    throw e;
  }
}

// "Delete" retires the vehicle: the row stays for history.
export async function retireVehicle(tenant: TenantContext, id: bigint): Promise<void> {
  notFound(await findVehicle(tenant.id, id), 'Vehicle not found');
  if ((await countCurrentSchedules(tenant.id, 'vehicle', id)) > 0) {
    throw new HttpError(409, 'Remove this vehicle from its route schedules first');
  }
  await db
    .update(vehicles)
    .set({ status: 'retired' })
    .where(and(eq(vehicles.id, id), eq(vehicles.tenantId, tenant.id)));
}

// ================================================================ DRIVERS
const LICENCE_TAKEN = 'That licence number is already used in this school';

export async function listDrivers(tenant: TenantContext, q: ListDriversInput): Promise<Page> {
  const where = and(
    eq(drivers.tenantId, tenant.id),
    q.status ? eq(drivers.status, q.status) : undefined,
    q.q
      ? or(ilike(drivers.fullName, `%${q.q}%`), ilike(drivers.phone, `%${q.q}%`), ilike(drivers.licenseNo, `%${q.q}%`))
      : undefined,
    q.expiringWithinDays
      ? and(ne(drivers.status, 'inactive'), lte(drivers.licenseExpiry, daysFromToday(q.expiringWithinDays)))
      : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(drivers)
      .where(where)
      .orderBy(asc(drivers.fullName))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(drivers).where(where),
  ]);
  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, total) };
}

export async function getDriver(tenant: TenantContext, id: bigint): Promise<unknown> {
  return toRow(notFound(await findDriver(tenant.id, id), 'Driver not found'));
}

export async function createDriver(tenant: TenantContext, _actor: AuthUser, input: CreateDriverInput): Promise<unknown> {
  if (input.staffId) await assertStaff(tenant.id, input.staffId, false);
  if (input.licenseExpiry < todayStr()) {
    throw new HttpError(400, 'Validation failed', [{ field: 'licenseExpiry', message: 'The licence has already expired' }]);
  }
  try {
    const [row] = await db
      .insert(drivers)
      .values({ ...input, tenantId: tenant.id })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, LICENCE_TAKEN);
    throw e;
  }
}

export async function updateDriver(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateDriverInput,
): Promise<unknown> {
  const existing = notFound(await findDriver(tenant.id, id), 'Driver not found');
  if (input.staffId) await assertStaff(tenant.id, input.staffId, false);
  if (input.status === 'inactive' && existing.status !== 'inactive') {
    if ((await countCurrentSchedules(tenant.id, 'driver', id)) > 0) {
      throw new HttpError(409, 'Remove this driver from the route schedules first');
    }
  }
  try {
    const [row] = await db
      .update(drivers)
      .set(input)
      .where(and(eq(drivers.id, id), eq(drivers.tenantId, tenant.id)))
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, LICENCE_TAKEN);
    throw e;
  }
}

export async function deactivateDriver(tenant: TenantContext, id: bigint): Promise<void> {
  notFound(await findDriver(tenant.id, id), 'Driver not found');
  if ((await countCurrentSchedules(tenant.id, 'driver', id)) > 0) {
    throw new HttpError(409, 'Remove this driver from the route schedules first');
  }
  await db
    .update(drivers)
    .set({ status: 'inactive' })
    .where(and(eq(drivers.id, id), eq(drivers.tenantId, tenant.id)));
}

// ================================================================ ROUTES
const ROUTE_CODE_TAKEN = 'That route code is already used in this school';

async function countActiveRiders(tenantId: bigint, routeId: bigint): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(transportAssignments)
    .where(
      and(
        eq(transportAssignments.tenantId, tenantId),
        eq(transportAssignments.routeId, routeId),
        eq(transportAssignments.status, 'active'),
      ),
    );
  return total;
}

function routeColumns(input: Partial<CreateRouteInput>) {
  const { distanceKm, ...plain } = input;
  return {
    ...plain,
    ...(distanceKm === undefined ? {} : { distanceKm: distanceKm === null ? null : distanceKm.toFixed(2) }),
  };
}

export async function listRoutes(tenant: TenantContext, q: ListRoutesInput): Promise<Page> {
  const where = and(
    eq(transportRoutes.tenantId, tenant.id),
    q.status ? eq(transportRoutes.status, q.status) : undefined,
    q.shift ? eq(transportRoutes.shift, q.shift) : undefined,
    q.q ? or(ilike(transportRoutes.name, `%${q.q}%`), ilike(transportRoutes.code, `%${q.q}%`)) : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(transportRoutes)
      .where(where)
      .orderBy(asc(transportRoutes.code))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(transportRoutes).where(where),
  ]);

  // pickup points per route on this page
  const counts = await db
    .select({ routeId: pickupPoints.routeId, total: count() })
    .from(pickupPoints)
    .where(eq(pickupPoints.tenantId, tenant.id))
    .groupBy(pickupPoints.routeId);
  const pointCount = new Map(counts.map((c) => [c.routeId, c.total]));

  return {
    rows: rows.map((r) => ({ ...toRow(r), pickupPointCount: pointCount.get(r.id) ?? 0 })),
    meta: pageMeta(q.page, q.limit, total),
  };
}

// One route with its stops, the schedules running now or later, and how many people ride it.
export async function getRoute(tenant: TenantContext, id: bigint): Promise<unknown> {
  const route = notFound(await findRoute(tenant.id, id), 'Route not found');
  const [points, schedules, riders] = await Promise.all([
    db
      .select()
      .from(pickupPoints)
      .where(and(eq(pickupPoints.tenantId, tenant.id), eq(pickupPoints.routeId, id)))
      .orderBy(asc(pickupPoints.sequence)),
    db
      .select({
        ...getTableColumns(routeSchedules),
        vehicleRegistrationNo: vehicles.registrationNo,
        driverName: drivers.fullName,
      })
      .from(routeSchedules)
      .innerJoin(vehicles, eq(routeSchedules.vehicleId, vehicles.id))
      .innerJoin(drivers, eq(routeSchedules.driverId, drivers.id))
      .where(
        and(
          eq(routeSchedules.tenantId, tenant.id),
          eq(routeSchedules.routeId, id),
          gte(routeSchedules.validTo, todayStr()),
        ),
      )
      .orderBy(asc(routeSchedules.shift)),
    countActiveRiders(tenant.id, id),
  ]);
  return {
    ...toRow(route),
    pickupPoints: points.map(toRow),
    currentSchedules: schedules.map(toRow),
    activeRiders: riders,
  };
}

export async function createRoute(tenant: TenantContext, _actor: AuthUser, input: CreateRouteInput): Promise<unknown> {
  try {
    const [row] = await db
      .insert(transportRoutes)
      .values({ ...routeColumns(input), tenantId: tenant.id, code: input.code, name: input.name })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, ROUTE_CODE_TAKEN);
    throw e;
  }
}

export async function updateRoute(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateRouteInput,
): Promise<unknown> {
  const existing = notFound(await findRoute(tenant.id, id), 'Route not found');
  if (input.status === 'inactive' && existing.status !== 'inactive') {
    if ((await countActiveRiders(tenant.id, id)) > 0) {
      throw new HttpError(409, 'End the route\'s transport assignments first');
    }
  }
  try {
    const [row] = await db
      .update(transportRoutes)
      .set(routeColumns(input))
      .where(and(eq(transportRoutes.id, id), eq(transportRoutes.tenantId, tenant.id)))
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, ROUTE_CODE_TAKEN);
    throw e;
  }
}

export async function deactivateRoute(tenant: TenantContext, id: bigint): Promise<void> {
  notFound(await findRoute(tenant.id, id), 'Route not found');
  if ((await countActiveRiders(tenant.id, id)) > 0) {
    throw new HttpError(409, 'End the route\'s transport assignments first');
  }
  await db
    .update(transportRoutes)
    .set({ status: 'inactive' })
    .where(and(eq(transportRoutes.id, id), eq(transportRoutes.tenantId, tenant.id)));
}

// ================================================================ PICKUP POINTS
const SEQUENCE_TAKEN = 'This route already has a stop with that sequence number';

function pointColumns(input: Partial<CreatePickupPointInput>) {
  const { latitude, longitude, monthlyFee, ...plain } = input;
  return {
    ...plain,
    ...(latitude === undefined ? {} : { latitude: latitude === null ? null : latitude.toFixed(6) }),
    ...(longitude === undefined ? {} : { longitude: longitude === null ? null : longitude.toFixed(6) }),
    ...(monthlyFee === undefined ? {} : { monthlyFee: monthlyFee.toFixed(2) }),
  };
}

export async function listPickupPoints(tenant: TenantContext, q: ListPickupPointsInput): Promise<unknown> {
  const rows = await db
    .select()
    .from(pickupPoints)
    .where(and(eq(pickupPoints.tenantId, tenant.id), q.routeId ? eq(pickupPoints.routeId, q.routeId) : undefined))
    .orderBy(asc(pickupPoints.routeId), asc(pickupPoints.sequence));
  return rows.map(toRow);
}

export async function createPickupPoint(
  tenant: TenantContext,
  _actor: AuthUser,
  input: CreatePickupPointInput,
): Promise<unknown> {
  must(await findRoute(tenant.id, input.routeId), 'Route not found in this school');
  try {
    const [row] = await db
      .insert(pickupPoints)
      .values({
        ...pointColumns(input),
        tenantId: tenant.id,
        routeId: input.routeId,
        name: input.name,
        sequence: input.sequence,
        monthlyFee: input.monthlyFee.toFixed(2),
      })
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, SEQUENCE_TAKEN);
    throw e;
  }
}

// Existing assignments keep the fee they were created with, even when the stop's fee changes.
export async function updatePickupPoint(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdatePickupPointInput,
): Promise<unknown> {
  notFound(await findPickupPoint(tenant.id, id), 'Pickup point not found');
  try {
    const [row] = await db
      .update(pickupPoints)
      .set(pointColumns(input))
      .where(and(eq(pickupPoints.id, id), eq(pickupPoints.tenantId, tenant.id)))
      .returning();
    return toRow(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new HttpError(409, SEQUENCE_TAKEN);
    throw e;
  }
}

// Real delete, only while nobody is (or was) assigned to the stop.
export async function removePickupPoint(tenant: TenantContext, id: bigint): Promise<void> {
  notFound(await findPickupPoint(tenant.id, id), 'Pickup point not found');
  const [{ total }] = await db
    .select({ total: count() })
    .from(transportAssignments)
    .where(and(eq(transportAssignments.tenantId, tenant.id), eq(transportAssignments.pickupPointId, id)));
  if (total > 0) throw new HttpError(409, 'This stop has transport assignments');
  await db.delete(pickupPoints).where(and(eq(pickupPoints.id, id), eq(pickupPoints.tenantId, tenant.id)));
}

// ================================================================ ROUTE SCHEDULES
interface ScheduleShape {
  routeId: bigint;
  vehicleId: bigint;
  driverId: bigint;
  attendantStaffId: bigint | null;
  shift: string;
  operatingDays: number[];
  validFrom: string;
  validTo: string;
}

// Every rule a schedule must satisfy. Used by both create and update.
async function validateSchedule(tenantId: bigint, s: ScheduleShape, selfId?: bigint): Promise<void> {
  if (s.validTo < s.validFrom) {
    throw new HttpError(400, 'Validation failed', [{ field: 'validTo', message: 'Cannot be before validFrom' }]);
  }

  const route = must(await findRoute(tenantId, s.routeId), 'Route not found in this school');
  if (route.status !== 'active') throw new HttpError(400, 'That route is not active');
  if (route.shift !== 'both' && route.shift !== s.shift) {
    throw new HttpError(400, `That route only runs in the ${route.shift} shift`);
  }

  const vehicle = must(await findVehicle(tenantId, s.vehicleId), 'Vehicle not found in this school');
  if (vehicle.status !== 'active') throw new HttpError(400, 'That vehicle is not active');

  const driver = must(await findDriver(tenantId, s.driverId), 'Driver not found in this school');
  if (driver.status !== 'active') throw new HttpError(400, 'That driver is not active');
  if (driver.licenseExpiry < todayStr()) throw new HttpError(400, 'The driver\'s licence has expired');

  if (s.attendantStaffId) await assertStaff(tenantId, s.attendantStaffId, true);

  // the vehicle and the driver can each be on only one route at a time: same shift, overlapping dates AND days
  const candidates = await db
    .select({
      vehicleId: routeSchedules.vehicleId,
      driverId: routeSchedules.driverId,
      operatingDays: routeSchedules.operatingDays,
    })
    .from(routeSchedules)
    .where(
      and(
        eq(routeSchedules.tenantId, tenantId),
        eq(routeSchedules.shift, s.shift),
        lte(routeSchedules.validFrom, s.validTo),
        gte(routeSchedules.validTo, s.validFrom),
        or(eq(routeSchedules.vehicleId, s.vehicleId), eq(routeSchedules.driverId, s.driverId)),
        selfId === undefined ? undefined : ne(routeSchedules.id, selfId),
      ),
    );
  const sameDays = candidates.filter((c) => c.operatingDays.some((d) => s.operatingDays.includes(d)));
  if (sameDays.some((c) => c.vehicleId === s.vehicleId)) {
    throw new HttpError(409, 'This vehicle is already on a route in that shift on overlapping days');
  }
  if (sameDays.some((c) => c.driverId === s.driverId)) {
    throw new HttpError(409, 'This driver is already on a route in that shift on overlapping days');
  }
}

export async function listSchedules(tenant: TenantContext, q: ListSchedulesInput): Promise<Page> {
  const where = and(
    eq(routeSchedules.tenantId, tenant.id),
    q.routeId ? eq(routeSchedules.routeId, q.routeId) : undefined,
    q.vehicleId ? eq(routeSchedules.vehicleId, q.vehicleId) : undefined,
    q.driverId ? eq(routeSchedules.driverId, q.driverId) : undefined,
    q.shift ? eq(routeSchedules.shift, q.shift) : undefined,
    q.activeOn ? and(lte(routeSchedules.validFrom, q.activeOn), gte(routeSchedules.validTo, q.activeOn)) : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        ...getTableColumns(routeSchedules),
        routeCode: transportRoutes.code,
        routeName: transportRoutes.name,
        vehicleRegistrationNo: vehicles.registrationNo,
        driverName: drivers.fullName,
      })
      .from(routeSchedules)
      .innerJoin(transportRoutes, eq(routeSchedules.routeId, transportRoutes.id))
      .innerJoin(vehicles, eq(routeSchedules.vehicleId, vehicles.id))
      .innerJoin(drivers, eq(routeSchedules.driverId, drivers.id))
      .where(where)
      .orderBy(asc(transportRoutes.code), asc(routeSchedules.shift))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(routeSchedules).where(where),
  ]);
  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, total) };
}

export async function createSchedule(
  tenant: TenantContext,
  _actor: AuthUser,
  input: CreateScheduleInput,
): Promise<unknown> {
  const shape: ScheduleShape = {
    routeId: input.routeId,
    vehicleId: input.vehicleId,
    driverId: input.driverId,
    attendantStaffId: input.attendantStaffId ?? null,
    shift: input.shift,
    operatingDays: [...input.operatingDays].sort((a, b) => a - b),
    validFrom: input.validFrom,
    validTo: input.validTo,
  };
  await validateSchedule(tenant.id, shape);
  const [row] = await db
    .insert(routeSchedules)
    .values({ ...shape, tenantId: tenant.id })
    .returning();
  return toRow(row);
}

export async function updateSchedule(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateScheduleInput,
): Promise<unknown> {
  const existing = notFound(await findSchedule(tenant.id, id), 'Schedule not found');
  const shape: ScheduleShape = {
    routeId: existing.routeId,
    vehicleId: input.vehicleId ?? existing.vehicleId,
    driverId: input.driverId ?? existing.driverId,
    attendantStaffId: input.attendantStaffId !== undefined ? input.attendantStaffId : existing.attendantStaffId,
    shift: input.shift ?? existing.shift,
    operatingDays: input.operatingDays ? [...input.operatingDays].sort((a, b) => a - b) : existing.operatingDays,
    validFrom: input.validFrom ?? existing.validFrom,
    validTo: input.validTo ?? existing.validTo,
  };
  await validateSchedule(tenant.id, shape, id);
  const [row] = await db
    .update(routeSchedules)
    .set(shape)
    .where(and(eq(routeSchedules.id, id), eq(routeSchedules.tenantId, tenant.id)))
    .returning();
  return toRow(row);
}

export async function removeSchedule(tenant: TenantContext, id: bigint): Promise<void> {
  notFound(await findSchedule(tenant.id, id), 'Schedule not found');
  await db.delete(routeSchedules).where(and(eq(routeSchedules.id, id), eq(routeSchedules.tenantId, tenant.id)));
}

// ================================================================ ASSIGNMENTS
// A person may ride the same route/stop only once per direction in a year ("both" covers pickup and drop).
async function assertNoDuplicate(
  tenantId: bigint,
  who: { studentId: bigint | null; staffId: bigint | null },
  academicYearId: bigint,
  direction: string,
  selfId?: bigint,
): Promise<void> {
  const rows = await db
    .select({ direction: transportAssignments.direction })
    .from(transportAssignments)
    .where(
      and(
        eq(transportAssignments.tenantId, tenantId),
        eq(transportAssignments.academicYearId, academicYearId),
        eq(transportAssignments.status, 'active'),
        who.studentId !== null
          ? eq(transportAssignments.studentId, who.studentId)
          : eq(transportAssignments.staffId, who.staffId as bigint),
        selfId === undefined ? undefined : ne(transportAssignments.id, selfId),
      ),
    );
  if (rows.some((r) => r.direction === 'both' || direction === 'both' || r.direction === direction)) {
    throw new HttpError(409, 'This person already has a transport assignment for that direction in this year');
  }
}

export async function listAssignments(tenant: TenantContext, actor: AuthUser, q: ListAssignmentsInput): Promise<Page> {
  const scope = await resolveStudentScope(tenant, actor.id, 'transport.view');
  const scopeCond = studentScopeCondition(transportAssignments.studentId, scope);
  if (scopeCond === null) return { rows: [], meta: pageMeta(q.page, q.limit, 0) };

  const where = and(
    eq(transportAssignments.tenantId, tenant.id),
    scopeCond,
    q.routeId ? eq(transportAssignments.routeId, q.routeId) : undefined,
    q.pickupPointId ? eq(transportAssignments.pickupPointId, q.pickupPointId) : undefined,
    q.studentId ? eq(transportAssignments.studentId, q.studentId) : undefined,
    q.staffId ? eq(transportAssignments.staffId, q.staffId) : undefined,
    q.academicYearId ? eq(transportAssignments.academicYearId, q.academicYearId) : undefined,
    q.status ? eq(transportAssignments.status, q.status) : undefined,
  );

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        ...getTableColumns(transportAssignments),
        routeCode: transportRoutes.code,
        routeName: transportRoutes.name,
        pickupPointName: pickupPoints.name,
      })
      .from(transportAssignments)
      .innerJoin(transportRoutes, eq(transportAssignments.routeId, transportRoutes.id))
      .innerJoin(pickupPoints, eq(transportAssignments.pickupPointId, pickupPoints.id))
      .where(where)
      .orderBy(asc(transportRoutes.code), asc(pickupPoints.sequence), asc(transportAssignments.id))
      .offset((q.page - 1) * q.limit)
      .limit(q.limit),
    db.select({ total: count() }).from(transportAssignments).where(where),
  ]);
  return { rows: rows.map(toRow), meta: pageMeta(q.page, q.limit, total) };
}

export async function createAssignment(
  tenant: TenantContext,
  _actor: AuthUser,
  input: CreateAssignmentInput,
): Promise<unknown> {
  const route = must(await findRoute(tenant.id, input.routeId), 'Route not found in this school');
  if (route.status !== 'active') throw new HttpError(400, 'That route is not active');

  const point = must(await findPickupPoint(tenant.id, input.pickupPointId), 'Pickup point not found in this school');
  if (point.routeId !== route.id) throw new HttpError(400, 'That pickup point is not on this route');

  const studentId = input.studentId ?? null;
  const staffId = input.staffId ?? null;
  if (staffId !== null) await assertStaff(tenant.id, staffId, true);
  // studentId is not checked yet: the students table does not exist

  const direction = input.direction ?? 'both';
  await assertNoDuplicate(tenant.id, { studentId, staffId }, input.academicYearId, direction);

  const [row] = await db
    .insert(transportAssignments)
    .values({
      tenantId: tenant.id,
      studentId,
      staffId,
      academicYearId: input.academicYearId,
      routeId: route.id,
      pickupPointId: point.id,
      direction,
      monthlyFee: input.monthlyFee !== undefined ? input.monthlyFee.toFixed(2) : point.monthlyFee,
    })
    .returning();
  return toRow(row);
}

export async function updateAssignment(
  tenant: TenantContext,
  _actor: AuthUser,
  id: bigint,
  input: UpdateAssignmentInput,
): Promise<unknown> {
  const existing = notFound(await findAssignment(tenant.id, id), 'Assignment not found');
  if (existing.status !== 'active') throw new HttpError(409, 'An ended assignment cannot be changed');

  if (input.pickupPointId !== undefined) {
    const point = must(await findPickupPoint(tenant.id, input.pickupPointId), 'Pickup point not found in this school');
    if (point.routeId !== existing.routeId) {
      throw new HttpError(400, 'That pickup point is on another route: end this assignment and create a new one');
    }
  }
  if (input.direction !== undefined) {
    await assertNoDuplicate(
      tenant.id,
      { studentId: existing.studentId, staffId: existing.staffId },
      existing.academicYearId,
      input.direction,
      id,
    );
  }

  const [row] = await db
    .update(transportAssignments)
    .set({
      pickupPointId: input.pickupPointId,
      direction: input.direction,
      monthlyFee: input.monthlyFee === undefined ? undefined : input.monthlyFee.toFixed(2),
    })
    .where(and(eq(transportAssignments.id, id), eq(transportAssignments.tenantId, tenant.id)))
    .returning();
  return toRow(row);
}

// "Delete" ends the assignment and keeps it, so past billing can still be traced.
export async function endAssignment(tenant: TenantContext, id: bigint): Promise<void> {
  notFound(await findAssignment(tenant.id, id), 'Assignment not found');
  await db
    .update(transportAssignments)
    .set({ status: 'ended' })
    .where(and(eq(transportAssignments.id, id), eq(transportAssignments.tenantId, tenant.id)));
}