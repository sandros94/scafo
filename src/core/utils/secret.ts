/* Comparing secrets without saying, through how long it took, where they differ. */

/**
 * Whether two secrets hold the same bytes, in time that does not depend on where
 * the first difference is. Every byte is folded into the answer even once a
 * difference is known, so a caller guessing a token one character at a time
 * learns nothing from how quickly it was refused.
 *
 * A length mismatch is answered at once and on purpose: the lengths are not the
 * secret, and there is nothing meaningful to compare a short guess against.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

/** {@link timingSafeEqual} over the UTF-8 encoding of two strings. */
export function timingSafeEqualText(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}
