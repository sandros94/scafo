/** SHA-256 of `data`, lowercase hex. Strings are hashed as UTF-8. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  /* Bytes are copied so the digest input is never backed by a SharedArrayBuffer. */
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
