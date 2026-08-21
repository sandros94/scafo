/* Base64 (RFC 4648 §4) and its url-safe alphabet (§5), unpadded. */

/** Encodes `bytes` as standard base64, `=` padding included. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}

/** Encodes `bytes` as base64url without `=` padding. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Decodes either alphabet, with or without padding. Throws on non-base64 input.
 * The result is backed by a plain `ArrayBuffer`, so it is accepted anywhere a
 * `BufferSource` is required (`crypto.subtle`, for one).
 */
export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const base64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i) ?? 0;
  return bytes;
}

/** {@link fromBase64} under the name a caller holding base64url reaches for. */
export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  return fromBase64(s);
}
