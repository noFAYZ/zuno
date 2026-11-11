/** Self-check for `decodeFrame`, the JS half of Rust's `framed_response`. */
export {};

import { decodeFrame } from "./ipcFrame";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

// Built exactly as Rust builds it: u32 LE metadata length, metadata JSON, raw body.
const meta = new TextEncoder().encode(JSON.stringify({ status: 200, mimeType: "audio/ogg" }));
const body = Uint8Array.from([0, 255, 128, 7]);
const frame = new Uint8Array(4 + meta.length + body.length);
new DataView(frame.buffer).setUint32(0, meta.length, true);
frame.set(meta, 4);
frame.set(body, 4 + meta.length);

const decoded = decodeFrame<{ status: number; mimeType: string }>(frame.buffer);
check(decoded.meta.status === 200 && decoded.meta.mimeType === "audio/ogg", "metadata round-trips");
check(decoded.body.join() === body.join(), "body bytes are untouched, including 0x00 and 0xFF");
check(decodeFrame(frame.buffer.slice(0, 4 + meta.length)).body.byteLength === 0, "empty body is empty");

console.log("ipcFrame.check: ok");
