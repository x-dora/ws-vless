import { BUFFER_TOO_SHORT_MESSAGE, processHeader, type UUIDValidator } from '../core/header';
import type { HeaderResult } from '../types';

type WorkerBytes = Uint8Array<ArrayBufferLike>;

export type InitialConnectionType = 'tcp' | 'udp' | 'mux';

export interface ParsedInitialChunk {
  header: HeaderResult;
  rawClientData: WorkerBytes;
  connectionType: InitialConnectionType;
}

interface InitialHeaderParserOptions {
  maxHeaderBytes?: number;
  headerTooLargeMessage?: string;
}

export class InitialHeaderParser {
  private headerBuffer: WorkerBytes = new Uint8Array(0) as WorkerBytes;

  constructor(
    private readonly validateUUID: UUIDValidator,
    private readonly options: InitialHeaderParserOptions = {},
  ) {}

  push(chunk: ArrayBuffer | ArrayBufferLike | Uint8Array): ParsedInitialChunk | null {
    this.appendHeaderChunk(chunk);

    const result = processHeader(this.headerBuffer, this.validateUUID);
    if (result.hasError) {
      if (result.message === BUFFER_TOO_SHORT_MESSAGE) {
        this.throwIfHeaderTooLarge();
        return null;
      }

      throw new Error(result.message ?? 'Invalid VLESS header');
    }

    const rawDataIndex = result.rawDataIndex;
    if (rawDataIndex === undefined) {
      throw new Error('Invalid header: missing raw data index');
    }

    return {
      header: result,
      rawClientData: this.takeRawClientData(rawDataIndex),
      connectionType: resolveConnectionType(result),
    };
  }

  private appendHeaderChunk(chunk: ArrayBuffer | ArrayBufferLike | Uint8Array): void {
    const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const newBuffer = new Uint8Array(this.headerBuffer.length + incoming.byteLength) as WorkerBytes;
    newBuffer.set(this.headerBuffer, 0);
    newBuffer.set(incoming, this.headerBuffer.length);
    this.headerBuffer = newBuffer;
  }

  private takeRawClientData(rawDataIndex: number): WorkerBytes {
    const rawClientData = this.headerBuffer.slice(rawDataIndex) as WorkerBytes;
    this.headerBuffer = new Uint8Array(0) as WorkerBytes;
    return rawClientData;
  }

  private throwIfHeaderTooLarge(): void {
    const maxHeaderBytes = this.options.maxHeaderBytes;
    if (maxHeaderBytes !== undefined && this.headerBuffer.byteLength > maxHeaderBytes) {
      throw new Error(this.options.headerTooLargeMessage ?? 'VLESS header exceeds limit');
    }
  }
}

function resolveConnectionType(result: HeaderResult): InitialConnectionType {
  if (result.isMux) {
    return 'mux';
  }

  if (result.isUDP) {
    return 'udp';
  }

  return 'tcp';
}
