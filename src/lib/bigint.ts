import {HttpError} from "./errors"

(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

export function parseId(value: unknown): bigint{
      if (typeof value !== 'string' || !/^\d{1,18}$/.test(value)) {
    throw new HttpError(400, 'Invalid id');
  }
  return BigInt(value);
}
