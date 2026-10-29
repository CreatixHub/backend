import { z } from 'zod';

// Names that would clash with URLs or look official.
export const RESERVED_SLUGS = ['api', 'admin', 'app', 'www', 'platform', 'karkaii', 'support', 'login', 'signup'];

export const createOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{2,40}$/, 'slug must be 3-41 characters: lowercase letters, digits and hyphens')
      .refine((s) => !RESERVED_SLUGS.includes(s), 'this slug is reserved'),
    timezone: z.string().max(60).optional(),
  })
  .strict();

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    timezone: z.string().max(60).optional(),
  })
  .strict();

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
