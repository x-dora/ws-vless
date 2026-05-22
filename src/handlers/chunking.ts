/**
 * Byte stream helpers shared by transport implementations.
 */

export function* splitIntoChunks(data: Uint8Array, chunkSize: number): Generator<Uint8Array> {
  let offset = 0;
  while (offset < data.length) {
    const end = Math.min(offset + chunkSize, data.length);
    yield data.subarray(offset, end);
    offset = end;
  }
}
