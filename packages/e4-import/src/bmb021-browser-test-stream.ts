// Test-only browser Web Streams API adapter for Bun-hosted original BOMC consumer.
// Browsers natively expose DecompressionStream('deflate'); Bun 1.3.0 here does not.
// No BOMC decode/CRC/geometry/semantic code is mocked or changed.
import { inflateSync } from 'node:zlib';
if (typeof globalThis.DecompressionStream === 'undefined') {
  class TestOnlyDeflateDecompressionStream {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    constructor(format: string) {
      if (format !== 'deflate') throw new TypeError('Unsupported test-only stream format');
      const chunks: Uint8Array[] = [];
      const stream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk) { chunks.push(chunk); },
        flush(controller) { controller.enqueue(new Uint8Array(inflateSync(Buffer.concat(chunks)))); }
      });
      this.readable = stream.readable;
      this.writable = stream.writable;
    }
  }
  Object.defineProperty(globalThis, 'DecompressionStream', {
    value: TestOnlyDeflateDecompressionStream, configurable: true, writable: true
  });
}
