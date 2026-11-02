/** Internal quota-history-v1 TLV encoding; no persistence or Trust policy. */
export class FingerprintInputError extends Error {
  constructor() {
    super("Invalid quota history fingerprint input");
  }
}
export function unsignedInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
  );
}
export function encodeHistoryField(tag: number, value: unknown): Buffer {
  let bytes: Buffer;
  if (tag === 0x01) {
    if (typeof value !== "string") throw new FingerprintInputError();
    bytes = Buffer.from(value, "utf8");
    // Never silently replace an unpaired UTF-16 surrogate with U+FFFD.
    if (bytes.toString("utf8") !== value) throw new FingerprintInputError();
  } else if (tag === 0x02 || tag === 0x05) {
    if (!unsignedInteger(value)) throw new FingerprintInputError();
    bytes = Buffer.from(String(value), "ascii");
  } else if (tag === 0x03 || tag === 0x04) {
    if (value !== null) throw new FingerprintInputError();
    bytes = Buffer.alloc(0);
  } else throw new FingerprintInputError();
  if (bytes.byteLength > 0xffff_ffff) throw new FingerprintInputError();
  const header = Buffer.alloc(5);
  header[0] = tag;
  header.writeUInt32BE(bytes.byteLength, 1);
  return Buffer.concat([header, bytes]);
}
