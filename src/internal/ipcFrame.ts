/**
 * Splits a binary IPC response built by Rust's `framed_response`:
 * `[u32 LE metadata length][metadata JSON][body]`. Bodies arrive as raw bytes, never base64.
 */
export function decodeFrame<T>(frame: ArrayBuffer): { meta: T; body: Uint8Array<ArrayBuffer> } {
  const length = new DataView(frame).getUint32(0, true);
  return {
    meta: JSON.parse(new TextDecoder().decode(new Uint8Array(frame, 4, length))) as T,
    body: new Uint8Array(frame, 4 + length),
  };
}
