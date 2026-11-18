import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { parseId } from '../../lib/bigint';
import { HttpError } from '../../lib/errors';
import { created } from '../../lib/respond';
import { hasPermission } from '../../lib/tenant';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { FILE_PURPOSES, IMAGE_MIME_TYPES, MAX_IMAGE_BYTES, locateFile, saveImage } from './files.service';

export const filesRouter = Router();

const uploadQuerySchema = z
  .object({
    purpose: z.enum(FILE_PURPOSES),
    filename: z.string().trim().max(200).optional(),
  })
  .strict();

// Who may upload what: a photo for an admission needs admissions rights, a student photo needs students.edit.
function requireUploadPermission(req: Request, _res: Response, next: NextFunction): void {
  const tenant = currentTenant(req);
  const { purpose } = uploadQuerySchema.parse(req.query);
  const allowed =
    purpose === 'admission_photo'
      ? hasPermission(tenant, 'admissions.create') || hasPermission(tenant, 'admissions.edit')
      : hasPermission(tenant, 'students.edit');
  if (!allowed) throw new HttpError(403, 'You do not have permission to do this');
  next();
}

// The image arrives as the raw request body (Content-Type image/jpeg | image/png | image/webp).
const rawImage = express.raw({ type: IMAGE_MIME_TYPES, limit: MAX_IMAGE_BYTES });
function readImageBody(req: Request, res: Response, next: NextFunction): void {
  rawImage(req, res, (err?: unknown) => {
    if ((err as { type?: string } | undefined)?.type === 'entity.too.large') {
      next(new HttpError(413, 'Image is larger than 5 MB'));
      return;
    }
    next(err);
  });
}

// POST /api/files?purpose=admission_photo&filename=photo.jpg
filesRouter.post('/', requireUploadPermission, readImageBody, async (req, res) => {
  const query = uploadQuerySchema.parse(req.query);
  if (!Buffer.isBuffer(req.body)) {
    throw new HttpError(400, 'Send the image as the request body with Content-Type image/jpeg, image/png or image/webp');
  }
  created(res, await saveImage(currentTenant(req), currentUser(req), query.purpose, query.filename, req.body));
});

// GET /api/files/:id/content - the image itself (signed-in members of the same school only)
filesRouter.get('/:id/content', async (req, res, next) => {
  const tenant = currentTenant(req);
  const canView = ['students.view', 'admissions.view', 'staff.view'].some((code) => hasPermission(tenant, code));
  if (!canView) throw new HttpError(403, 'You do not have permission to do this');

  const { row, absolute } = await locateFile(tenant, parseId(req.params.id));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.type(row.mimeType);
  res.sendFile(absolute, (err) => {
    if (err && !res.headersSent) next(new HttpError(404, 'File not found'));
  });
});