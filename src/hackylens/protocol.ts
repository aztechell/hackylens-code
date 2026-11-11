// SPDX-License-Identifier: MIT
// HMPY v1 wire codec for the HackyLens Pybricks Code derivative.

export const PROTOCOL_VERSION = 1;
export const LINE_HANDSHAKE = new TextEncoder().encode('HKMPROTO 1\n');
export const LINE_READY = 'HKMPROTO 1 READY';
export const MAX_PAYLOAD_SIZE = 1024;
export const HEADER_SIZE = 16;
export const CRC_SIZE = 4;
export const MAX_RAW_FRAME = HEADER_SIZE + MAX_PAYLOAD_SIZE + CRC_SIZE;
export const MAX_ENCODED_PACKET = MAX_RAW_FRAME + Math.floor(MAX_RAW_FRAME / 254) + 1;

const MAGIC = new Uint8Array([0x48, 0x4d, 0x50, 0x59]);

export enum MessageType {
    HELLO = 0x01,
    LIST = 0x02,
    STAT = 0x03,
    READ = 0x04,
    UPLOAD_BEGIN = 0x10,
    UPLOAD_CHUNK = 0x11,
    UPLOAD_COMMIT = 0x12,
    UPLOAD_ABORT = 0x13,
    DELETE = 0x20,
    SET_STARTUP = 0x21,
    FORMAT = 0x22,
    RUN = 0x30,
    STOP = 0x31,
    STATUS = 0x32,
    PING = 0x40,
    SESSION_CLOSE = 0x41,
    CAMERA = 0x50,
    STDOUT = 0x80,
    STDERR = 0x81,
    STATE = 0x82,
    FILE_CHANGED = 0x83,
    DROPPED = 0x84,
}

export enum FrameFlag {
    RESPONSE = 0x0001,
    ERROR = 0x0002,
    MORE = 0x0004,
}

export enum CodecStatus {
    ARGUMENT = 'argument',
    COBS_MALFORMED = 'cobs-malformed',
    ENCODED_TOO_LARGE = 'encoded-too-large',
    FRAME_TOO_SHORT = 'frame-too-short',
    BAD_MAGIC = 'bad-magic',
    UNSUPPORTED_VERSION = 'unsupported-version',
    UNKNOWN_TYPE = 'unknown-type',
    RESERVED_FLAGS = 'reserved-flags',
    INVALID_ENVELOPE = 'invalid-envelope',
    PAYLOAD_TOO_LARGE = 'payload-too-large',
    LENGTH_MISMATCH = 'length-mismatch',
    CRC_MISMATCH = 'crc-mismatch',
}

export class ProtocolError extends Error {
    public constructor(public readonly status: CodecStatus, message?: string) {
        super(message ?? status);
        this.name = 'ProtocolError';
    }
}

export interface Frame {
    readonly type: MessageType;
    readonly flags: FrameFlag;
    readonly requestId: number;
    readonly payload: Uint8Array;
}

export interface DecodeEvent {
    readonly frame?: Frame;
    readonly error?: ProtocolError;
}

const knownTypes = new Set<number>(Object.values(MessageType).filter((value) => typeof value === 'number') as number[]);
const flagMask = FrameFlag.RESPONSE | FrameFlag.ERROR | FrameFlag.MORE;

function fail(status: CodecStatus, message?: string): never {
    throw new ProtocolError(status, message);
}

function validateEnvelope(type: number, flags: number, requestId: number): MessageType {
    if (!knownTypes.has(type)) {
        fail(CodecStatus.UNKNOWN_TYPE);
    }
    if (!Number.isInteger(flags) || flags < 0 || flags > 0xffff || (flags & ~flagMask) !== 0) {
        fail(CodecStatus.RESERVED_FLAGS);
    }
    if (!Number.isInteger(requestId) || requestId < 0 || requestId > 0xffffffff) {
        fail(CodecStatus.INVALID_ENVELOPE);
    }
    const isEvent = type >= MessageType.STDOUT && type <= MessageType.DROPPED;
    if (isEvent) {
        if (flags !== 0 || requestId !== 0) {
            fail(CodecStatus.INVALID_ENVELOPE);
        }
    } else {
        if (requestId === 0) {
            fail(CodecStatus.INVALID_ENVELOPE);
        }
        if ((flags & (FrameFlag.ERROR | FrameFlag.MORE)) !== 0 &&
            (flags & FrameFlag.RESPONSE) === 0) {
            fail(CodecStatus.INVALID_ENVELOPE);
        }
    }
    return type as MessageType;
}

let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
    if (crcTable) {
        return crcTable;
    }
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[index] = value >>> 0;
    }
    crcTable = table;
    return table;
}

export function crc32(data: Uint8Array): number {
    const table = getCrcTable();
    let value = 0xffffffff;
    for (const byte of data) {
        value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
}

export function cobsEncode(data: Uint8Array): Uint8Array {
    const output = new Uint8Array(data.length + Math.floor(data.length / 254) + 2);
    let write = 1;
    let codeIndex = 0;
    let code = 1;
    for (const byte of data) {
        if (byte === 0) {
            output[codeIndex] = code;
            codeIndex = write;
            write += 1;
            code = 1;
        } else {
            output[write] = byte;
            write += 1;
            code += 1;
            if (code === 0xff) {
                output[codeIndex] = code;
                codeIndex = write;
                write += 1;
                code = 1;
            }
        }
    }
    output[codeIndex] = code;
    return output.slice(0, write);
}

export function cobsDecode(packet: Uint8Array): Uint8Array {
    if (packet.length === 0 || packet.includes(0)) {
        fail(CodecStatus.COBS_MALFORMED);
    }
    const output = new Uint8Array(MAX_RAW_FRAME);
    let read = 0;
    let write = 0;
    while (read < packet.length) {
        const code = packet[read];
        read += 1;
        const copyLength = code - 1;
        if (code === 0 || copyLength > packet.length - read) {
            fail(CodecStatus.COBS_MALFORMED);
        }
        if (write + copyLength > output.length) {
            fail(CodecStatus.ENCODED_TOO_LARGE);
        }
        output.set(packet.subarray(read, read + copyLength), write);
        read += copyLength;
        write += copyLength;
        if (code !== 0xff && read < packet.length) {
            if (write >= output.length) {
                fail(CodecStatus.ENCODED_TOO_LARGE);
            }
            output[write] = 0;
            write += 1;
        }
    }
    return output.slice(0, write);
}

export function encodeFrame(frame: Frame): Uint8Array {
    const type = validateEnvelope(frame.type, frame.flags, frame.requestId);
    if (!(frame.payload instanceof Uint8Array)) {
        fail(CodecStatus.ARGUMENT);
    }
    if (frame.payload.length > MAX_PAYLOAD_SIZE) {
        fail(CodecStatus.PAYLOAD_TOO_LARGE);
    }
    const raw = new Uint8Array(HEADER_SIZE + frame.payload.length + CRC_SIZE);
    raw.set(MAGIC, 0);
    raw[4] = PROTOCOL_VERSION;
    raw[5] = type;
    const view = new DataView(raw.buffer);
    view.setUint16(6, frame.flags, true);
    view.setUint32(8, frame.requestId, true);
    view.setUint32(12, frame.payload.length, true);
    raw.set(frame.payload, HEADER_SIZE);
    view.setUint32(HEADER_SIZE + frame.payload.length,
        crc32(raw.subarray(0, HEADER_SIZE + frame.payload.length)), true);
    const encoded = cobsEncode(raw);
    if (encoded.length > MAX_ENCODED_PACKET) {
        fail(CodecStatus.ENCODED_TOO_LARGE);
    }
    const wire = new Uint8Array(encoded.length + 1);
    wire.set(encoded);
    return wire;
}

export function decodeRaw(raw: Uint8Array): Frame {
    if (raw.length < HEADER_SIZE + CRC_SIZE) {
        fail(CodecStatus.FRAME_TOO_SHORT);
    }
    if (!MAGIC.every((byte, index) => raw[index] === byte)) {
        fail(CodecStatus.BAD_MAGIC);
    }
    if (raw[4] !== PROTOCOL_VERSION) {
        fail(CodecStatus.UNSUPPORTED_VERSION);
    }
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const flags = view.getUint16(6, true);
    const requestId = view.getUint32(8, true);
    const payloadLength = view.getUint32(12, true);
    if (payloadLength > MAX_PAYLOAD_SIZE) {
        fail(CodecStatus.PAYLOAD_TOO_LARGE);
    }
    if (raw.length !== HEADER_SIZE + payloadLength + CRC_SIZE) {
        fail(CodecStatus.LENGTH_MISMATCH);
    }
    const type = validateEnvelope(raw[5], flags, requestId);
    const crcOffset = HEADER_SIZE + payloadLength;
    if (view.getUint32(crcOffset, true) !== crc32(raw.subarray(0, crcOffset))) {
        fail(CodecStatus.CRC_MISMATCH);
    }
    return {
        type,
        flags: flags as FrameFlag,
        requestId,
        payload: raw.slice(HEADER_SIZE, crcOffset),
    };
}

export function decodePacket(packet: Uint8Array): Frame {
    if (packet.length > MAX_ENCODED_PACKET) {
        fail(CodecStatus.ENCODED_TOO_LARGE);
    }
    return decodeRaw(cobsDecode(packet));
}

export function decodeFrame(wire: Uint8Array): Frame {
    if (wire.length === 0 || wire[wire.length - 1] !== 0 || wire.subarray(0, -1).includes(0)) {
        fail(CodecStatus.COBS_MALFORMED);
    }
    return decodePacket(wire.subarray(0, wire.length - 1));
}

export class StreamDecoder {
    private readonly buffer: number[] = [];
    private discarding = false;
    public errorCount = 0;
    public lastError: CodecStatus | undefined;

    public reset(): void {
        this.buffer.length = 0;
        this.discarding = false;
        this.lastError = undefined;
    }

    public feed(data: Uint8Array): DecodeEvent[] {
        const events: DecodeEvent[] = [];
        for (const byte of data) {
            if (byte !== 0) {
                if (!this.discarding) {
                    if (this.buffer.length >= MAX_ENCODED_PACKET) {
                        this.buffer.length = 0;
                        this.discarding = true;
                    } else {
                        this.buffer.push(byte);
                    }
                }
                continue;
            }
            if (this.discarding) {
                this.discarding = false;
                this.buffer.length = 0;
                const error = new ProtocolError(CodecStatus.ENCODED_TOO_LARGE);
                this.errorCount += 1;
                this.lastError = error.status;
                events.push({ error });
                continue;
            }
            if (this.buffer.length === 0) {
                continue;
            }
            const packet = Uint8Array.from(this.buffer);
            this.buffer.length = 0;
            try {
                const frame = decodePacket(packet);
                this.lastError = undefined;
                events.push({ frame });
            } catch (error) {
                const protocolError = error instanceof ProtocolError
                    ? error
                    : new ProtocolError(CodecStatus.ARGUMENT, String(error));
                this.errorCount += 1;
                this.lastError = protocolError.status;
                events.push({ error: protocolError });
            }
        }
        return events;
    }
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}
