import { Router } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { staff, students, users } from '../../db/schema';
import { parseId } from '../../lib/bigint';
import { HttpError } from '../../lib/errors';
import { noContent, ok } from '../../lib/respond';
import { hasPermission } from '../../lib/tenant';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { locateFile } from './files.service';

// "My photo": the signed-in person's OWN picture (student, teacher or admin).
// The admin uploads it (student form / staff form); the person only views it here.
// Mounted at /api/files/me BEFORE /api/files so it is found first.

async function myPhotoFileId(tenantId: bigint, userId: bigint, avatarFileId: bigint | null): Promise<bigint | null> {
  if (avatarFileId) return avatarFileId;

  const [t] = await db
    .select({ photo: staff.photoFileId })
    .from(staff)
    .where(and(eq(staff.tenantId, tenantId), eq(staff.userId, userId), isNull(staff.deletedAt)))
    .limit(1);
  if (t?.photo) return t.photo;

  const [s] = await db
    .select({ photo: students.photoFileId })
    .from(students)
    .where(and(eq(students.tenantId, tenantId), eq(students.userId, userId), isNull(students.deletedAt)))
    .limit(1);
  if (s?.photo) return s.photo;

  return null;
}

export const myPhotoRouter = Router();

// GET /api/files/me -> { photoFileId: "12" | null }
myPhotoRouter.get('/', async (req, res) => {
  const tenant = currentTenant(req);
  const user = currentUser(req);
  const id = await myPhotoFileId(tenant.id, user.id, user.avatarFileId ?? null);
  ok(res, { photoFileId: id ? String(id) : null });
});

// GET /api/files/me/content -> the image bytes
myPhotoRouter.get('/content', async (req, res, next) => {
  const tenant = currentTenant(req);
  const user = currentUser(req);
  const id = await myPhotoFileId(tenant.id, user.id, user.avatarFileId ?? null);
  if (!id) throw new HttpError(404, 'No photo');

  const { row, absolute } = await locateFile(tenant, id);
  res.setHeader('Cache-Control', 'private, no-cache');
  res.type(row.mimeType);
  res.sendFile(absolute, (err) => {
    if (err && !res.headersSent) next(new HttpError(404, 'File not found'));
  });
});

// PUT /api/files/me/avatar { fileId: "12" | null } -> set or remove MY OWN profile photo.
// Only people who may upload photos (admin) can do this; the file must belong to this school.
const avatarSchema = z.object({ fileId: z.string().regex(/^[0-9]+$/).nullable() }).strict();

myPhotoRouter.put('/avatar', async (req, res) => {
  const tenant = currentTenant(req);
  const user = currentUser(req);
  if (!hasPermission(tenant, 'students.edit') && !hasPermission(tenant, 'staff.edit')) {
    throw new HttpError(403, 'You do not have permission to do this');
  }
  const { fileId } = avatarSchema.parse(req.body);
  let value: bigint | null = null;
  if (fileId) {
    value = parseId(fileId);
    await locateFile(tenant, value); // 404 if it is not a file of this school
  }
  await db.update(users).set({ avatarFileId: value }).where(eq(users.id, user.id));
  noContent(res);
});
