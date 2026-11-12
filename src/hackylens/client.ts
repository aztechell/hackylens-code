// SPDX-License-Identifier: MIT

import {
    FrameFlag,
    LINE_HANDSHAKE,
    LINE_READY,
    MAX_PAYLOAD_SIZE,
    MessageType,
    StreamDecoder,
    concatBytes,
    crc32,
    encodeFrame,
} from './protocol';
import type { Frame } from './protocol';
import type { ByteTransport } from './serial';

export const NAME_MAX = 63;
export const FILE_MAX = 256 * 1024;
export const UPLOAD_DATA_MAX = 1016;
export const RUN_TIME_MAX_MS = 300_000;
export const FORMAT_TOKEN = 'ERASE USERFS';
export const CAPABILITIES_V1_REQUIRED = 0xff;
export const CAP_BOOT_FLAGS = 1 << 8;
export const CAP_CAMERA = 1 << 9;

const HANDSHAKE_TIMEOUT_MS = 8000;
const HANDSHAKE_RETRY_MS = 350;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const fileNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export enum ErrorCode {
    OK = 0,
    INVALID_REQUEST = 1,
    UNSUPPORTED_VERSION = 2,
    UNSUPPORTED_TYPE = 3,
    INVALID_PAYLOAD = 4,
    NOT_FOUND = 5,
    ALREADY_EXISTS = 6,
    BUSY = 7,
    PERMISSION_DENIED = 8,
    NO_SPACE = 9,
    IO = 10,
    CRC_MISMATCH = 11,
    OFFSET_MISMATCH = 12,
    LIMIT_EXCEEDED = 13,
    NOT_RUNNING = 14,
    TIMEOUT = 15,
    INTERNAL = 16,
    CONFIRMATION_REQUIRED = 17,
    SESSION_EXPIRED = 18,
}

export enum RuntimeState {
    STOPPED = 0,
    STARTING = 1,
    RUNNING = 2,
    STOPPING = 3,
    FINISHED = 4,
    ERROR = 5,
}

export enum FileSystemState {
    UNINITIALIZED = 0,
    UNSUPPORTED_FLASH = 1,
    UNFORMATTED = 2,
    CORRUPT = 3,
    IO_ERROR = 4,
    MOUNTED = 5,
}

export enum BootFlag {
    WDT1_RECOVERY = 1 << 0,
}

export interface HelloInfo {
    readonly protocolVersion: number;
    readonly filesystemState: FileSystemState;
    readonly runtimeState: RuntimeState;
    readonly bootFlags: number;
    readonly capabilities: number;
    readonly maxPayload: number;
    readonly uploadChunk: number;
    readonly nameMax: number;
    readonly sourceMax: number;
    readonly fileMax: number;
    readonly filesystemTotal: number;
    readonly filesystemUsed: number;
    readonly firmwareVersion: string;
    readonly board: string;
}

export interface FileInfo {
    readonly name: string;
    readonly size: number;
    readonly startup: boolean;
}

export interface CameraFrame {
    readonly width: number;
    readonly height: number;
    readonly pixels: Uint8ClampedArray;
    readonly format: 'rgb332' | 'rgb565';
}

export interface RuntimeStatus {
    readonly runtimeState: RuntimeState;
    readonly exitReason: number;
    readonly filesystemState: FileSystemState;
    readonly filesystemError: number;
    readonly runId: number;
    readonly sourceBytes: number;
    readonly outputPending: number;
    readonly outputDropped: number;
    readonly startedUs: bigint;
    readonly heartbeatUs: bigint;
    readonly deadlineUs: bigint;
    readonly filesystemTotal: number;
    readonly filesystemUsed: number;
}

export interface HmpyEvent {
    readonly type: MessageType;
    readonly runId?: number;
    readonly sequence?: number | bigint;
    readonly data?: Uint8Array;
    readonly state?: RuntimeState;
    readonly exitReason?: number;
    readonly droppedStream?: number;
    readonly droppedCount?: number;
    readonly fileOperation?: number;
    readonly fileName?: string;
}

export class HmpyClientError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'HmpyClientError';
    }
}

export class HmpyTimeout extends HmpyClientError {
    public constructor(message: string) {
        super(message);
        this.name = 'HmpyTimeout';
    }
}

export class HmpyRemoteError extends HmpyClientError {
    public readonly code: number;
    public readonly detail: string;

    public constructor(code: number, detail: string) {
        const name = ErrorCode[code] ?? `ERROR_${code}`;
        super(detail ? `${name}: ${detail}` : name);
        this.code = code;
        this.detail = detail;
        this.name = 'HmpyRemoteError';
    }
}

interface PendingRequest {
    readonly type: MessageType;
    readonly frames: Frame[];
    readonly resolve: (frames: Frame[]) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

export interface HmpyClientOptions {
    readonly requestTimeoutMs?: number;
    readonly onEvent?: (event: HmpyEvent) => void;
    readonly onDisconnect?: (error?: Error) => void;
}

function viewOf(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u32(value: number): Uint8Array {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError('u32 value is out of range');
    }
    const output = new Uint8Array(4);
    viewOf(output).setUint32(0, value, true);
    return output;
}

function readName(payload: Uint8Array, offset = 0): [string, number] {
    if (offset >= payload.length) {
        throw new HmpyClientError('В ответе отсутствует длина имени.');
    }
    const length = payload[offset];
    const start = offset + 1;
    const end = start + length;
    if (length > NAME_MAX || end > payload.length) {
        throw new HmpyClientError('Некорректное имя в ответе устройства.');
    }
    try {
        return [utf8Decoder.decode(payload.subarray(start, end)), end];
    } catch {
        throw new HmpyClientError('Имя устройства содержит некорректный UTF-8.');
    }
}

export function packName(name: string, allowEmpty = false): Uint8Array {
    if ((!allowEmpty || name.length !== 0) && !fileNamePattern.test(name)) {
        throw new HmpyClientError('Имя: латинские буквы/цифры и символы . _ -, без каталогов.');
    }
    const encoded = utf8Encoder.encode(name);
    if ((!allowEmpty && encoded.length === 0) || encoded.length > NAME_MAX) {
        throw new HmpyClientError(`Имя должно занимать 1–${NAME_MAX} байта.`);
    }
    return concatBytes(Uint8Array.of(encoded.length), encoded);
}

function remoteError(frame: Frame): HmpyRemoteError {
    if (frame.payload.length < 4) {
        return new HmpyRemoteError(ErrorCode.INTERNAL, 'повреждённый error envelope');
    }
    const view = viewOf(frame.payload);
    const code = view.getUint16(0, true);
    const detailLength = view.getUint16(2, true);
    if (detailLength !== frame.payload.length - 4) {
        return new HmpyRemoteError(ErrorCode.INTERNAL, 'неверная длина ошибки');
    }
    const detail = new TextDecoder().decode(frame.payload.subarray(4));
    return new HmpyRemoteError(code, detail);
}

export class HmpyClient {
    private readonly decoder = new StreamDecoder();
    private readonly pending = new Map<number, PendingRequest>();
    private readonly requestTimeoutMs: number;
    private requestId = 0;
    private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
    private keepaliveBusy = false;
    private closing = false;
    private active = false;

    public constructor(
        private readonly transport: ByteTransport,
        private readonly options: HmpyClientOptions = {},
    ) {
        this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    }

    public get isOpen(): boolean {
        return this.active;
    }

    public get hasPendingRequests(): boolean {
        return this.pending.size !== 0;
    }

    public async open(timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<void> {
        if (this.active) {
            return;
        }

        let stopHandshake = false;
        let wakeRetry: (() => void) | undefined;
        let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
        const line: number[] = [];

        // This deadline belongs to the serial-mode handshake. In particular,
        // it must not inherit the (usually much shorter) framed-request timeout.
        const timeoutFailure = new Promise<never>((_resolve, reject) => {
            handshakeTimer = setTimeout(() => {
                reject(new HmpyTimeout('Устройство не вошло в HMPY-режим.'));
            }, timeoutMs);
        });

        const stopRetries = (): void => {
            stopHandshake = true;
            wakeRetry?.();
            wakeRetry = undefined;
        };

        const waitForRetry = (): Promise<void> => new Promise((resolve) => {
            const wake = (): void => {
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(() => {
                if (wakeRetry === wake) {
                    wakeRetry = undefined;
                }
                resolve();
            }, HANDSHAKE_RETRY_MS);
            wakeRetry = wake;
        });

        const retryHandshake = async (): Promise<void> => {
            while (!stopHandshake) {
                await this.transport.write(LINE_HANDSHAKE);
                if (stopHandshake) {
                    return;
                }
                await waitForRetry();
            }
        };

        const readUntilReady = async (): Promise<Uint8Array> => {
            while (true) {
                const chunk = await this.transport.read();
                if (chunk === null) {
                    throw new HmpyClientError('Порт закрылся во время HMPY handshake.');
                }
                for (let index = 0; index < chunk.length; index += 1) {
                    const byte = chunk[index];
                    if (byte === 10) {
                        const text = new TextDecoder().decode(Uint8Array.from(line.filter((b) => b !== 13)));
                        line.length = 0;
                        if (text === LINE_READY) {
                            stopRetries();
                            return chunk.subarray(index + 1);
                        }
                    } else if (line.length < 256) {
                        line.push(byte);
                    } else {
                        line.length = 0;
                    }
                }
            }
        };

        // Start the reader before the first probe so an immediate READY cannot
        // race with reader acquisition. A normal retry-loop exit never wins the
        // race; only a failed write is surfaced through retryFailure.
        const ready = readUntilReady();
        const retryFailure = new Promise<never>((_resolve, reject) => {
            void retryHandshake().catch(reject);
        });

        try {
            const trailing = await Promise.race([ready, retryFailure, timeoutFailure]);
            this.decoder.reset();
            this.active = true;
            if (trailing.length !== 0) {
                this.dispatchBytes(trailing);
            }
            void this.readLoop();
            this.startKeepalive();
        } catch (error) {
            stopRetries();
            this.active = false;
            this.decoder.reset();
            // A Web Serial close waits for queued writes. Do not let a wedged
            // handshake write defeat the bounded open() deadline; closing is
            // still initiated and any cleanup failure is deliberately ignored
            // in favour of the original handshake error.
            try {
                void this.transport.close().catch(() => undefined);
            } catch {
                // A non-conforming transport may throw before returning a promise.
            }
            throw error;
        } finally {
            stopRetries();
            if (handshakeTimer !== undefined) {
                clearTimeout(handshakeTimer);
            }
        }
    }

    private nextRequestId(): number {
        this.requestId = (this.requestId + 1) >>> 0;
        if (this.requestId === 0) {
            this.requestId = 1;
        }
        return this.requestId;
    }

    private async readLoop(): Promise<void> {
        try {
            while (this.active) {
                const chunk = await this.transport.read();
                if (chunk === null) {
                    if (this.active) {
                        throw new HmpyClientError('Последовательный порт отключён.');
                    }
                    return;
                }
                this.dispatchBytes(chunk);
            }
        } catch (error) {
            if (this.active) {
                this.terminate(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    private dispatchBytes(bytes: Uint8Array): void {
        for (const decoded of this.decoder.feed(bytes)) {
            if (decoded.error) {
                throw decoded.error;
            }
            if (decoded.frame) {
                this.dispatchFrame(decoded.frame);
            }
        }
    }

    private dispatchFrame(frame: Frame): void {
        if (frame.requestId === 0) {
            this.options.onEvent?.(this.decodeEvent(frame));
            return;
        }
        const pending = this.pending.get(frame.requestId);
        if (!pending || pending.type !== frame.type ||
            (frame.flags & FrameFlag.RESPONSE) === 0) {
            throw new HmpyClientError('Получен неожиданный HMPY-ответ.');
        }
        if ((frame.flags & FrameFlag.ERROR) !== 0) {
            this.pending.delete(frame.requestId);
            clearTimeout(pending.timer);
            pending.reject(remoteError(frame));
            return;
        }
        pending.frames.push(frame);
        if ((frame.flags & FrameFlag.MORE) === 0) {
            this.pending.delete(frame.requestId);
            clearTimeout(pending.timer);
            pending.resolve(pending.frames);
        }
    }

    private decodeEvent(frame: Frame): HmpyEvent {
        const payload = frame.payload;
        const view = viewOf(payload);
        if (frame.type === MessageType.STDOUT || frame.type === MessageType.STDERR) {
            if (payload.length < 8) {
                throw new HmpyClientError('Короткое событие вывода.');
            }
            return {
                type: frame.type,
                runId: view.getUint32(0, true),
                sequence: view.getUint32(4, true),
                data: payload.slice(8),
            };
        }
        if (frame.type === MessageType.STATE) {
            if (payload.length !== 14) {
                throw new HmpyClientError('Некорректное событие состояния.');
            }
            return {
                type: frame.type,
                state: payload[0] as RuntimeState,
                exitReason: payload[1],
                runId: view.getUint32(2, true),
                sequence: view.getBigUint64(6, true),
            };
        }
        if (frame.type === MessageType.FILE_CHANGED) {
            if (payload.length < 2) {
                throw new HmpyClientError('Некорректное событие файла.');
            }
            const [fileName, end] = readName(payload, 1);
            if (end !== payload.length) {
                throw new HmpyClientError('Лишние данные события файла.');
            }
            return { type: frame.type, fileOperation: payload[0], fileName };
        }
        if (frame.type === MessageType.DROPPED) {
            if (payload.length !== 9) {
                throw new HmpyClientError('Некорректное событие потери данных.');
            }
            return {
                type: frame.type,
                droppedStream: payload[0],
                runId: view.getUint32(1, true),
                droppedCount: view.getUint32(5, true),
            };
        }
        throw new HmpyClientError(`Неизвестное событие 0x${frame.type.toString(16)}.`);
    }

    private terminate(error: Error): void {
        this.active = false;
        if (this.keepaliveTimer !== undefined) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = undefined;
        }
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
        void this.transport.close();
        if (!this.closing) {
            this.options.onDisconnect?.(error);
        }
    }

    private startKeepalive(): void {
        this.keepaliveTimer = setInterval(() => {
            if (!this.active || this.keepaliveBusy || this.pending.size !== 0) {
                return;
            }
            this.keepaliveBusy = true;
            void this.ping(Uint8Array.of(0x48, 0x4b)).catch((error: unknown) => {
                if (this.active) {
                    this.terminate(error instanceof Error ? error : new Error(String(error)));
                }
            }).finally(() => {
                this.keepaliveBusy = false;
            });
        }, 3000);
    }

    public request(
        type: MessageType,
        payload: Uint8Array = new Uint8Array(),
        timeoutMs = this.requestTimeoutMs,
    ): Promise<Frame[]> {
        if (!this.active) {
            return Promise.reject(new HmpyClientError('HMPY-сессия не открыта.'));
        }
        if (payload.length > MAX_PAYLOAD_SIZE) {
            return Promise.reject(new HmpyClientError('Payload превышает предел HMPY.'));
        }
        const requestId = this.nextRequestId();
        const wire = encodeFrame({ type, flags: 0 as FrameFlag, requestId, payload });
        return new Promise<Frame[]>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new HmpyTimeout(`Тайм-аут ${MessageType[type]}.`));
            }, timeoutMs);
            this.pending.set(requestId, { type, frames: [], resolve, reject, timer });
            void this.transport.write(wire).catch((error: unknown) => {
                const pending = this.pending.get(requestId);
                if (!pending) {
                    return;
                }
                this.pending.delete(requestId);
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
    }

    public async hello(): Promise<HelloInfo> {
        const payload = (await this.request(MessageType.HELLO))[0].payload;
        if (payload.length < 30) {
            throw new HmpyClientError('Короткий HELLO-ответ.');
        }
        const view = viewOf(payload);
        let offset = 28;
        const [firmwareVersion, next] = readName(payload, offset);
        offset = next;
        const [board, end] = readName(payload, offset);
        if (end !== payload.length) {
            throw new HmpyClientError('Лишние данные HELLO-ответа.');
        }
        const result: HelloInfo = {
            protocolVersion: payload[0],
            filesystemState: payload[1] as FileSystemState,
            runtimeState: payload[2] as RuntimeState,
            bootFlags: payload[3],
            capabilities: view.getUint32(4, true),
            maxPayload: view.getUint16(8, true),
            uploadChunk: view.getUint16(10, true),
            nameMax: view.getUint16(12, true),
            sourceMax: view.getUint16(14, true),
            fileMax: view.getUint32(16, true),
            filesystemTotal: view.getUint32(20, true),
            filesystemUsed: view.getUint32(24, true),
            firmwareVersion,
            board,
        };
        if (result.protocolVersion !== 1 || result.maxPayload > MAX_PAYLOAD_SIZE ||
            result.uploadChunk > UPLOAD_DATA_MAX) {
            throw new HmpyClientError('Несовместимый профиль HMPY v1.');
        }
        return result;
    }

    public async listFiles(): Promise<FileInfo[]> {
        const frames = await this.request(MessageType.LIST);
        const files: FileInfo[] = [];
        for (const frame of frames) {
            if (frame.payload.length === 0) {
                continue;
            }
            const [name, offset] = readName(frame.payload);
            if (frame.payload.length - offset !== 4) {
                throw new HmpyClientError('Некорректная запись LIST.');
            }
            files.push({ name, size: viewOf(frame.payload).getUint32(offset, true), startup: false });
        }
        return files;
    }

    public async stat(name: string): Promise<FileInfo> {
        const payload = (await this.request(MessageType.STAT, packName(name)))[0].payload;
        if (payload.length !== 5) {
            throw new HmpyClientError('Некорректный STAT-ответ.');
        }
        return {
            name,
            size: viewOf(payload).getUint32(0, true),
            startup: payload[4] !== 0,
        };
    }

    public async readFile(name: string, offset = 0, length = 0): Promise<Uint8Array> {
        const request = concatBytes(packName(name), u32(offset), u32(length));
        const frames = await this.request(MessageType.READ, request, Math.max(35_000, this.requestTimeoutMs));
        const chunks: Uint8Array[] = [];
        let expectedOffset = offset;
        let total: number | undefined;
        for (const frame of frames) {
            if (frame.payload.length < 8) {
                throw new HmpyClientError('Некорректный READ-ответ.');
            }
            const view = viewOf(frame.payload);
            const chunkOffset = view.getUint32(0, true);
            const chunkTotal = view.getUint32(4, true);
            const data = frame.payload.slice(8);
            if (chunkOffset !== expectedOffset || (total !== undefined && total !== chunkTotal) ||
                chunkOffset > chunkTotal || data.length > chunkTotal - chunkOffset) {
                throw new HmpyClientError('Непоследовательный READ-ответ.');
            }
            total = chunkTotal;
            expectedOffset += data.length;
            chunks.push(data);
        }
        if (total === undefined || total < offset) {
            throw new HmpyClientError('READ-ответ отсутствует или повреждён.');
        }
        const expectedLength = length === 0
            ? total - offset
            : Math.min(length, total - offset);
        const output = concatBytes(...chunks);
        if (output.length !== expectedLength) {
            throw new HmpyClientError('Устройство вернуло усечённый файл.');
        }
        return output;
    }

    public async cameraFrame(snapshot = false): Promise<CameraFrame> {
        const frames = await this.request(MessageType.CAMERA, Uint8Array.of(Number(snapshot)), 10_000);
        const nativeWidth = snapshot ? 160 : 96;
        const nativeHeight = snapshot ? 120 : 72;
        const bytes = new Uint8Array(nativeWidth * nativeHeight * (snapshot ? 2 : 1));
        let width = 0;
        let height = 0;
        let offset = 0;
        for (const { payload } of frames) {
            if (payload.length <= 8) {
                throw new HmpyClientError('Короткий пакет камеры.');
            }
            const view = viewOf(payload);
            const w = view.getUint16(0, true);
            const h = view.getUint16(2, true);
            const data = payload.subarray(8);
            if (!((w === nativeWidth && h === nativeHeight) || (w === nativeHeight && h === nativeWidth)) ||
                (offset !== 0 && (w !== width || h !== height)) ||
                view.getUint32(4, true) !== offset || offset + data.length > bytes.length) {
                throw new HmpyClientError('Неверный размер или смещение пакета камеры.');
            }
            width = w;
            height = h;
            bytes.set(data, offset);
            offset += data.length;
        }
        if (offset !== bytes.length) {
            throw new HmpyClientError('Кадр камеры получен не полностью.');
        }
        const pixels = new Uint8ClampedArray(width * height * 4);
        const raw = viewOf(bytes);
        for (let i = 0; i < width * height; i++) {
            const pixel = snapshot ? raw.getUint16(i * 2, true) : bytes[i];
            pixels[i * 4] = snapshot ? ((pixel >> 11) & 31) * 255 / 31 : (pixel >> 5) * 255 / 7;
            pixels[i * 4 + 1] = snapshot ? ((pixel >> 5) & 63) * 255 / 63 : ((pixel >> 2) & 7) * 255 / 7;
            pixels[i * 4 + 2] = snapshot ? (pixel & 31) * 255 / 31 : (pixel & 3) * 85;
            pixels[i * 4 + 3] = 255;
        }
        return { width, height, pixels, format: snapshot ? 'rgb565' : 'rgb332' };
    }

    public async stopCamera(): Promise<void> {
        await this.request(MessageType.CAMERA, Uint8Array.of(2));
    }

    public async upload(name: string, data: Uint8Array): Promise<void> {
        if (data.length > FILE_MAX) {
            throw new HmpyClientError('Файл превышает предел 256 КиБ.');
        }
        const begin = (await this.request(
            MessageType.UPLOAD_BEGIN,
            concatBytes(packName(name), u32(data.length), u32(crc32(data))),
        ))[0].payload;
        if (begin.length !== 8) {
            throw new HmpyClientError('Некорректный UPLOAD_BEGIN-ответ.');
        }
        const beginView = viewOf(begin);
        const uploadId = beginView.getUint32(0, true);
        let offset = beginView.getUint32(4, true);
        try {
            while (offset < data.length) {
                const chunk = data.slice(offset, offset + UPLOAD_DATA_MAX);
                const response = (await this.request(
                    MessageType.UPLOAD_CHUNK,
                    concatBytes(u32(uploadId), u32(offset), chunk),
                ))[0].payload;
                if (response.length !== 8) {
                    throw new HmpyClientError('Некорректный UPLOAD_CHUNK-ответ.');
                }
                const responseView = viewOf(response);
                const acknowledged = responseView.getUint32(4, true);
                if (responseView.getUint32(0, true) !== uploadId ||
                    acknowledged !== offset + chunk.length) {
                    throw new HmpyClientError('Устройство неверно подтвердило upload chunk.');
                }
                offset = acknowledged;
            }
            await this.request(MessageType.UPLOAD_COMMIT, u32(uploadId));
        } catch (error) {
            try {
                await this.request(MessageType.UPLOAD_ABORT, u32(uploadId));
            } catch {
                // Preserve the upload failure; stale uploads are removed on mount.
            }
            throw error;
        }
    }

    public async delete(name: string): Promise<void> {
        await this.request(MessageType.DELETE, packName(name));
    }

    public async setStartup(name?: string): Promise<void> {
        await this.request(MessageType.SET_STARTUP, packName(name ?? '', true));
    }

    public async formatUserfs(confirmation: string): Promise<void> {
        if (confirmation !== FORMAT_TOKEN) {
            throw new HmpyClientError(`Введите точную фразу ${FORMAT_TOKEN}.`);
        }
        await this.request(MessageType.FORMAT, utf8Encoder.encode(FORMAT_TOKEN), 15_000);
    }

    public async run(name?: string, timeLimitMs = 0): Promise<number> {
        if (!Number.isInteger(timeLimitMs) || timeLimitMs < 0 || timeLimitMs > RUN_TIME_MAX_MS) {
            throw new HmpyClientError('Лимит запуска должен быть 0–300000 мс.');
        }
        const response = (await this.request(
            MessageType.RUN,
            concatBytes(packName(name ?? '', true), u32(timeLimitMs)),
        ))[0].payload;
        if (response.length !== 4) {
            throw new HmpyClientError('Некорректный RUN-ответ.');
        }
        return viewOf(response).getUint32(0, true);
    }

    public async stop(): Promise<void> {
        await this.request(MessageType.STOP);
    }

    public async status(): Promise<RuntimeStatus> {
        const payload = (await this.request(MessageType.STATUS))[0].payload;
        if (payload.length !== 52) {
            throw new HmpyClientError('Некорректный STATUS-ответ.');
        }
        const view = viewOf(payload);
        return {
            runtimeState: payload[0] as RuntimeState,
            exitReason: payload[1],
            filesystemState: payload[2] as FileSystemState,
            filesystemError: payload[3],
            runId: view.getUint32(4, true),
            sourceBytes: view.getUint32(8, true),
            outputPending: view.getUint32(12, true),
            outputDropped: view.getUint32(16, true),
            startedUs: view.getBigUint64(20, true),
            heartbeatUs: view.getBigUint64(28, true),
            deadlineUs: view.getBigUint64(36, true),
            filesystemTotal: view.getUint32(44, true),
            filesystemUsed: view.getUint32(48, true),
        };
    }

    public async ping(payload = new Uint8Array()): Promise<Uint8Array> {
        const response = (await this.request(MessageType.PING, payload))[0].payload;
        if (response.length !== payload.length || response.some((byte, index) => byte !== payload[index])) {
            throw new HmpyClientError('PING echo не совпал с запросом.');
        }
        return response;
    }

    public async close(): Promise<void> {
        if (!this.active) {
            await this.transport.close();
            return;
        }
        this.closing = true;
        try {
            try {
                await this.request(MessageType.SESSION_CLOSE, new Uint8Array(), 1500);
            } finally {
                this.active = false;
                if (this.keepaliveTimer !== undefined) {
                    clearInterval(this.keepaliveTimer);
                    this.keepaliveTimer = undefined;
                }
                await this.transport.close();
                this.decoder.reset();
            }
        } finally {
            this.closing = false;
        }
    }
}
