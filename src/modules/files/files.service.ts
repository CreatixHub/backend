import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db';
import { files } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import type { TenantContext } from '../../lib/tenant';
import type { AuthUser } from '../../middleware/authenticate';

export const FILE_PURPOSES = ['admission_photo', 'student_photo'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Everything is stored under this folder: <UPLOAD_DIR>/<tenantId>/<random-uuid>.<ext> */
const UPLOAD_ROOT = path.resolve(config.UPLOAD_DIR);

/** Decides the real type from the first bytes, so a renamed .exe cannot pass as a photo. */
function sniffImage(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

const safeName = (name: string | undefined) =>
  path.basename(name ?? 'upload').replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'upload';

export async function saveImage(
  tenant: TenantContext,
  actor: AuthUser,
  purpose: FilePurpose,
  originalName: string | undefined,
  body: Buffer,
) {
  if (body.length === 0) throw new HttpError(400, 'The image is empty');
  if (body.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'Image is larger than 5 MB');
  const kind = sniffImage(body);
  if (!kind) throw new HttpError(400, 'Only JPG, PNG or WebP images are allowed');

  const storageKey = `${tenant.id}/${randomUUID()}.${kind.ext}`;
  const absolute = path.join(UPLOAD_ROOT, storageKey);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, body);

  const [row] = await db
    .insert(files)
    .values({
      tenantId: tenant.id,
      purpose,
      originalName: safeName(originalName),
      mimeType: kind.mime,
      sizeBytes: body.length,
      storageKey,
      uploadedBy: actor.id,
    })
    .returning();

  return {
    id: row.id,
    purpose: row.purpose,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}

/** The file row (only if it belongs to this school) and its location on disk. */
export async function locateFile(tenant: TenantContext, id: bigint) {
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, id), eq(files.tenantId, tenant.id), isNull(files.deletedAt)))
    .limit(1);
  if (!row) throw new HttpError(404, 'File not found');

  const absolute = path.resolve(UPLOAD_ROOT, row.storageKey);
  if (!absolute.startsWith(UPLOAD_ROOT + path.sep)) throw new HttpError(404, 'File not found');
  return { row, absolute };
}