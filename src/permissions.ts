// The permission catalogue and the default roles every new school receives. This file is DATA: the seed script
// loads PERMISSIONS into the database, and creating a school copies DEFAULT_ROLES into it.

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'import', 'export', 'approve', 'print', 'download', 'manage'];

// 8 modules from your frontend's Roles & Permissions screen + 3 backend modules = 11 x 10 actions = 110 permissions.
export const MODULES = [
  'dashboard', 'students', 'admissions', 'teachers', 'academics', 'attendance', 'examinations', 'finance',
  'organization', 'members', 'roles',
];

export interface PermissionDef {
  code: string; // "students.create"
  module: string;
  action: string;
  description: string;
}

// TODO: generate all 110 with a loop - do NOT type them by hand:
//   MODULES.flatMap((module) => ACTIONS.map((action) => ({ code: module + '.' + action, module, action,
//     description: 'Can ' + action + ' ' + module })))
export const PERMISSIONS: PermissionDef[] = [];

export interface RoleDef {
  code: string;
  name: string;
  description: string;
  permissions: string[]; // permission codes
}

// Helper: every permission of one module, e.g. all('finance') -> ['finance.view', ..., 'finance.manage']
export const all = (module: string): string[] => ACTIONS.map((a) => module + '.' + a);

// TODO: the 12 roles. Table (from guide section B4):
//   owner         : NOTHING listed - it is a wildcard in code (already done below)
//   admin         : every permission code EXCEPT 'organization.manage'   (PERMISSIONS.map(p => p.code).filter(...))
//   teacher       : dashboard.view; students.view; attendance.view/create/edit; academics.view; examinations.view/create/edit
//   accountant    : dashboard.view; students.view; all('finance')
//   receptionist  : dashboard.view; students.view; admissions.view/create/edit
//   student, parent, librarian, warden, transport_manager, nurse, security : dashboard.view only
export const DEFAULT_ROLES: RoleDef[] = [
  { code: 'owner', name: 'Owner', description: 'Full control. The person who created the school.', permissions: [] },
  // TODO admin
  // TODO teacher
  // TODO accountant
  // TODO receptionist
  // TODO student, parent, librarian, warden, transport_manager, nurse, security
];
