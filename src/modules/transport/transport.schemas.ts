import { z } from 'zod';

export const VEHICLE_TYPES = ['bus', 'van', 'car'] as const;
export const VEHICLE_STATUSES = ['active', 'maintenance', 'retired'] as const;
export const ACTIVE_STATUSES = ['active', 'inactive'] as const;
export const ROUTE_SHIFTS = ['morning', 'afternoon', 'both'] as const;
export const SCHEDULE_SHIFTS = ['morning', 'afternoon'] as const;
export const DIRECTIONS = ['pickup', 'drop', 'both'] as const;
export const ASSIGNMENT_STATUSES = ['active', 'ended'] as const;

const id = z.coerce.bigint().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
const money = z.number().min(0).max(10_000_000);
const nonEmpty = (v: object) => Object.keys(v).length > 0;
const paging = (defaultLimit = 20) => ({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(defaultLimit),
});
const clock = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)');
// YYYY-MM-DD, and a REAL date (rejects 2026-02-31)
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(v + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Invalid date');

// ---------------------------------------------------------------- vehicles
const vehicleFields = {
  registrationNo: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9 -]{3,19}$/, 'Registration number: 4 to 20 letters, digits, spaces or -'),
  vehicleType: z.enum(VEHICLE_TYPES),
  seatingCapacity: z.number().int().min(1).max(100),
  insuranceExpiry: isoDate.nullish(),
  fitnessExpiry: isoDate.nullish(),
  permitExpiry: isoDate.nullish(),
  pollutionExpiry: isoDate.nullish(),
  gpsDeviceId: text(60).nullish(),
  chassisNo: text(40).nullish(),
  engineNo: text(40).nullish(),
  make: text(60).nullish(),
  model: text(60).nullish(),
  manufactureYear: z.number().int().min(1980).max(2100).nullish(),
  odometerKm: z.number().int().min(0).max(10_000_000).nullish(),
  status: z.enum(VEHICLE_STATUSES).optional(),
};

export const listVehiclesSchema = z
  .object({
    ...paging(),
    q: z.string().trim().max(100).optional(), // registration number, make, model
    vehicleType: z.enum(VEHICLE_TYPES).optional(),
    status: z.enum(VEHICLE_STATUSES).optional(),
    expiringWithinDays: z.coerce.number().int().min(1).max(365).optional(), // any document expired or expiring soon
  })
  .strict();
export const createVehicleSchema = z.object(vehicleFields).strict();
export const updateVehicleSchema = z.object(vehicleFields).partial().strict().refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- drivers
const driverFields = {
  staffId: id.nullish(), // null for an outsourced driver
  fullName: text(120),
  phone: text(20),
  licenseNo: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9 -]{4,24}$/, 'Licence number: 5 to 25 letters, digits, spaces or -'),
  licenseExpiry: isoDate,
  status: z.enum(ACTIVE_STATUSES).optional(),
};

export const listDriversSchema = z
  .object({
    ...paging(),
    q: z.string().trim().max(100).optional(), // name, phone, licence number
    status: z.enum(ACTIVE_STATUSES).optional(),
    expiringWithinDays: z.coerce.number().int().min(1).max(365).optional(), // licence expired or expiring soon
  })
  .strict();
export const createDriverSchema = z.object(driverFields).strict();
export const updateDriverSchema = z.object(driverFields).partial().strict().refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- routes
const routeFields = {
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{1,20}$/, 'Code: up to 20 letters, digits, - or _'),
  name: text(120),
  startLocation: text(200).nullish(),
  endLocation: text(200).nullish(),
  distanceKm: z.number().min(0).max(9999.99).nullish(),
  estimatedMinutes: z.number().int().min(1).max(600).nullish(),
  shift: z.enum(ROUTE_SHIFTS).optional(), // defaults to morning
  status: z.enum(ACTIVE_STATUSES).optional(),
};

export const listRoutesSchema = z
  .object({
    ...paging(),
    q: z.string().trim().max(100).optional(),
    status: z.enum(ACTIVE_STATUSES).optional(),
    shift: z.enum(ROUTE_SHIFTS).optional(),
  })
  .strict();
export const createRouteSchema = z.object(routeFields).strict();
export const updateRouteSchema = z.object(routeFields).partial().strict().refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- pickup points
const pickupPointFields = {
  routeId: id,
  name: text(120),
  sequence: z.number().int().min(1).max(200), // order of the stop along the route
  landmark: text(200).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  pickupTime: clock.nullish(),
  dropTime: clock.nullish(),
  monthlyFee: money,
};

export const listPickupPointsSchema = z.object({ routeId: id.optional() }).strict();
export const createPickupPointSchema = z.object(pickupPointFields).strict();
// a stop never moves to another route
export const updatePickupPointSchema = z
  .object(pickupPointFields)
  .omit({ routeId: true })
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- route schedules
const operatingDays = z
  .array(z.number().int().min(1).max(7)) // 1 = Monday ... 7 = Sunday
  .min(1)
  .max(7)
  .refine((d) => new Set(d).size === d.length, 'Days must not repeat');

const scheduleFields = {
  routeId: id,
  vehicleId: id,
  driverId: id,
  attendantStaffId: id.nullish(),
  shift: z.enum(SCHEDULE_SHIFTS),
  operatingDays,
  validFrom: isoDate,
  validTo: isoDate,
};

export const listSchedulesSchema = z
  .object({
    ...paging(),
    routeId: id.optional(),
    vehicleId: id.optional(),
    driverId: id.optional(),
    shift: z.enum(SCHEDULE_SHIFTS).optional(),
    activeOn: isoDate.optional(), // only schedules valid on this date
  })
  .strict();
export const createScheduleSchema = z
  .object(scheduleFields)
  .strict()
  .refine((v) => v.validTo >= v.validFrom, { message: 'validTo cannot be before validFrom', path: ['validTo'] });
export const updateScheduleSchema = z
  .object(scheduleFields)
  .omit({ routeId: true })
  .partial()
  .strict()
  .refine(nonEmpty, 'Nothing to change');

// ---------------------------------------------------------------- assignments
const assignmentFields = {
  studentId: id.nullish(),
  staffId: id.nullish(),
  academicYearId: id,
  routeId: id,
  pickupPointId: id,
  direction: z.enum(DIRECTIONS).optional(), // defaults to both
  monthlyFee: money.optional(), // defaults to the pickup point's fee
};

export const listAssignmentsSchema = z
  .object({
    ...paging(),
    routeId: id.optional(),
    pickupPointId: id.optional(),
    studentId: id.optional(),
    staffId: id.optional(),
    academicYearId: id.optional(),
    status: z.enum(ASSIGNMENT_STATUSES).optional(),
  })
  .strict();
export const createAssignmentSchema = z
  .object(assignmentFields)
  .strict()
  .refine((v) => (v.studentId != null) !== (v.staffId != null), {
    message: 'Send exactly one of studentId or staffId',
    path: ['studentId'],
  });
// to change the route, end the assignment and create a new one
export const updateAssignmentSchema = z
  .object({ pickupPointId: id.optional(), direction: z.enum(DIRECTIONS).optional(), monthlyFee: money.optional() })
  .strict()
  .refine(nonEmpty, 'Nothing to change');

export type ListVehiclesInput = z.infer<typeof listVehiclesSchema>;
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;
export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;
export type ListDriversInput = z.infer<typeof listDriversSchema>;
export type CreateDriverInput = z.infer<typeof createDriverSchema>;
export type UpdateDriverInput = z.infer<typeof updateDriverSchema>;
export type ListRoutesInput = z.infer<typeof listRoutesSchema>;
export type CreateRouteInput = z.infer<typeof createRouteSchema>;
export type UpdateRouteInput = z.infer<typeof updateRouteSchema>;
export type ListPickupPointsInput = z.infer<typeof listPickupPointsSchema>;
export type CreatePickupPointInput = z.infer<typeof createPickupPointSchema>;
export type UpdatePickupPointInput = z.infer<typeof updatePickupPointSchema>;
export type ListSchedulesInput = z.infer<typeof listSchedulesSchema>;
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;
export type ListAssignmentsInput = z.infer<typeof listAssignmentsSchema>;
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;
export type UpdateAssignmentInput = z.infer<typeof updateAssignmentSchema>;