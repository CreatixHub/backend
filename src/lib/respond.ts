import type { Response } from "express";

// Every success response uses the envelope your frontend expects: { success, data, meta }.

export function ok(res: Response, data: unknown, meta?: unknown) {
  res.json({ success: true, data, meta });
}

export function created(res: Response, data: unknown) {
  res.status(201).json({ success: true, data });
}

export function noContent(res: Response) {
  res.status(204).end(); // no body at all
}
