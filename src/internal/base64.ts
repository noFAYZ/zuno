/**
 * Byte-oriented base64 for request bodies sent over IPC. `btoa` only accepts Latin-1, so bytes are
 * walked into a binary string first; passing decoded UTF-8 would corrupt anything above 0x7F.
 */

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
