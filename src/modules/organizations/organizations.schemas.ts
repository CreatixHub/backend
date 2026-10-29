import { z } from 'zod';

// Names that would clash with URLs or look official.
export const RESERVED_SLUGS = ['api', 'admin', 'app', 'www', 'platform', 'karkaii', 'support', 'login', 'signup'];

// TODO (C10b): name      string, trim, 2-120
//              slug      string matching /^[a-z0-9][a-z0-9-]{2,40}$/ (message: 'slug must be 3-41 characters: lowercase letters, digits and hyphens')
//                        and NOT in RESERVED_SLUGS (.refine)
//              timezone  OPTIONAL string, max 60
export const createOrganizationSchema = z.object({}).strict();

// TODO (C10d): name OPTIONAL (trim, 2-120), timezone OPTIONAL (max 60)
export const updateOrganizationSchema = z.object({}).strict();

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
