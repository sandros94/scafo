/* Random identifiers, as lowercase hex, from the platform's entropy. */

/** `bytes` random bytes as `2 × bytes` lowercase hex characters. */
export function randomHex(bytes: number): string {
  let hex = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(bytes))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
