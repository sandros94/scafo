/* Unpadded base64url (RFC 4648 §5), the encoding used inside varset envelopes. */

/** Encodes `bytes` as base64url without `=` padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Decodes base64url, with or without padding. Throws on non-base64 input. The
 * result is backed by a plain `ArrayBuffer`, so it is accepted anywhere a
 * `BufferSource` is required (`crypto.subtle`, for one).
 */
export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const base64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i) ?? 0;
  return bytes;
}
