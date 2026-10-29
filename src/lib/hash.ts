import { createHash } from "node:crypto";

// Refresh tokens are random 384-bit strings, so a fast hash is enough (passwords are different:
// they use argon2). We store only the hash, so a leaked database cannot be used to sign in.
export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
