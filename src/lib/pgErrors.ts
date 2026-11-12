const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

function pgCode(e: unknown): unknown {
  if (typeof e !== 'object' || e === null) return undefined;
  const err = e as { code?: unknown; cause?: { code?: unknown } };
  return err.code ?? err.cause?.code;
}

export function isUniqueViolation(e: unknown): boolean {
  return pgCode(e) === UNIQUE_VIOLATION;
}

export function isForeignKeyViolation(e: unknown): boolean {
  return pgCode(e) === FOREIGN_KEY_VIOLATION;
}
