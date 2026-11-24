// The permission catalogue and the default roles every new school receives. This file is DATA: the seed script
// loads PERMISSIONS into the database, and creating a school copies DEFAULT_ROLES into it.

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'import', 'export', 'approve', 'print', 'download', 'manage'];

// 10 original modules (frontend Roles & Permissions screen + backend modules; 'teachers' is replaced by 'staff')
// + 10 more new modules = 21 x 10 actions = 210 permissions.
export const MODULES = [
  'dashboard', 'students', 'admissions', 'academics', 'attendance', 'examinations', 'finance',
  'organization', 'members', 'roles',
  // new modules ('staff' replaces 'teachers' and covers teaching + non-teaching staff)
  'staff', 'subjects', 'classes', 'timetable', 'homework', 'calendar',
  'leaves', 'expenses', 'transport', 'assets', 'gatepass',
];

export interface PermissionDef {
  code: string; // "students.create"
  module: string;
  action: string;
  description: string;
}

// Generated, never typed by hand: every module x every action.
export const PERMISSIONS: PermissionDef[] = MODULES.flatMap((module) =>
  ACTIONS.map((action) => ({
    code: module + '.' + action,
    module,
    action,
    description: 'Can ' + action + ' ' + module,
  })),
);

export interface RoleDef {
  code: string;
  name: string;
  description: string;
  permissions: string[]; // permission codes
}

// Helper: every permission of one module, e.g. all('finance') -> ['finance.view', ..., 'finance.manage']
export const all = (module: string): string[] => ACTIONS.map((a) => module + '.' + a);

// Everybody in a school may open the dashboard and see basic details of their own school.
const dashboardOnly = ['dashboard.view', 'organization.view'];

export const DEFAULT_ROLES: RoleDef[] = [
  // owner has NO rows: it is a wildcard in code (see lib/tenant.ts), so new permissions apply automatically.
  { code: 'owner', name: 'Owner', description: 'Full control. The person who created the school.', permissions: [] },
  {
    code: 'admin',
    name: 'Administrator',
    description: 'Runs the school day to day.',
    permissions: PERMISSIONS.map((p) => p.code).filter((c) => c !== 'organization.manage'),
  },
  {
    code: 'teacher',
    name: 'Teacher',
    description: 'Teaches classes, takes attendance and enters exam marks.',
    permissions: [
      ...dashboardOnly, 'students.view',
      'attendance.view', 'attendance.create', 'attendance.edit',
      'academics.view',
      'examinations.view', 'examinations.create', 'examinations.edit',
      'subjects.view', 'classes.view', 'timetable.view',
      'homework.view', 'homework.create', 'homework.edit', 'homework.delete',
      'calendar.view',
      'leaves.view', 'leaves.create',
    ],
  },
  {
    code: 'accountant',
    name: 'Accountant',
    description: 'Manages fees, expenses and finance.',
    permissions: [...dashboardOnly, 'students.view', ...all('finance'), ...all('expenses')],
  },
  {
    code: 'receptionist',
    name: 'Receptionist',
    description: 'Handles enquiries, admissions and front-desk gate passes.',
    permissions: [
      ...dashboardOnly, 'students.view',
      'admissions.view', 'admissions.create', 'admissions.edit',
      'gatepass.view', 'gatepass.create',
    ],
  },
  {
    code: 'student',
    name: 'Student',
    description: 'A student of the school.',
    permissions: [
      ...dashboardOnly,
      'homework.view', 'attendance.view',
      'leaves.view', 'leaves.create',
      'gatepass.create',
    ],
  },
  {
    code: 'parent',
    name: 'Parent',
    description: 'A parent or guardian.',
    permissions: [
      ...dashboardOnly,
      'homework.view', 'attendance.view',
      'leaves.create',
      'finance.view',
    ],
  },
  { code: 'librarian', name: 'Librarian', description: 'Runs the library.', permissions: dashboardOnly },
  { code: 'warden', name: 'Warden', description: 'Runs the hostel.', permissions: dashboardOnly },
  {
    code: 'transport_manager',
    name: 'Transport manager',
    description: 'Runs school transport.',
    permissions: [...dashboardOnly, ...all('transport')],
  },
  { code: 'nurse', name: 'Nurse', description: 'School health room.', permissions: dashboardOnly },
  {
    code: 'security',
    name: 'Security',
    description: 'Gate and campus security.',
    permissions: [...dashboardOnly, ...all('gatepass'), 'attendance.view'],
  },
];