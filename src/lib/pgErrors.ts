const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

function pgField(e: unknown, field: 'code' | 'constraint'): unknown {
  if (typeof e !== 'object' || e === null) return undefined;
  const err = e as { code?: unknown; constraint?: unknown; cause?: { code?: unknown; constraint?: unknown } };
  return err[field] ?? err.cause?.[field];
}

export function isUniqueViolation(e: unknown): boolean {
  return pgField(e, 'code') === UNIQUE_VIOLATION;
}

export function isForeignKeyViolation(e: unknown): boolean {
  return pgField(e, 'code') === FOREIGN_KEY_VIOLATION;
}

export function pgConstraint(e: unknown): string | undefined {
  const value = pgField(e, 'constraint');
  return typeof value === 'string' ? value : undefined;
}
