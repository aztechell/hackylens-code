// SPDX-License-Identifier: MIT

import {
    BootFlag,
    CAP_BOOT_FLAGS,
    CAP_CAMERA,
    FileSystemState,
    HmpyClient,
    HmpyEvent,
    HmpyTimeout,
    RuntimeState,
    packName,
} from './client';
import { boardProfile } from './boards';
import {
    Frame,
    FrameFlag,
    LINE_HANDSHAKE,
    MessageType,
    concatBytes,
    decodeFrame,
    encodeFrame,
} from './protocol';
import { ByteTransport } from './serial';

const encoder = new TextEncoder();

function scalar(size: 2 | 4, value: number): Uint8Array {
    const output = new Uint8Array(size);
    const view = new DataView(output.buffer);
    if (size === 2) {
        view.setUint16(0, value, true);
    } else {
        view.setUint32(0, value, true);
    }
    return output;
}

function parseName(payload: Uint8Array): [string, number] {
    const length = payload[0];
    return [new TextDecoder().decode(payload.subarray(1, 1 + length)), 1 + length];
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

class FakeDevice implements ByteTransport {
    private readonly queue: Uint8Array[] = [];
    private readonly readers: Array<(value: Uint8Array | null) => void> = [];
    private readonly files = new Map<string, Uint8Array>();
    private upload: { id: number; name: string; bytes: Uint8Array } | undefined;
    private startup = '';
    private closed = false;
    private readyScheduled = false;
    private runId = 0;
    public pingRequests = 0;
    public handshakeWrites = 0;
    public closeCalls = 0;
    public badCameraOffset = false;

    public constructor(
        private readonly formatDelayMs = 0,
        private readonly readyDelayMs: number | null = 0,
        private readonly board = 'K210',
    ) {}

    private push(value: Uint8Array): void {
        const reader = this.readers.shift();
        if (reader) {
            reader(value);
        } else {
            this.queue.push(value);
        }
    }

    private send(frame: Frame): void {
        this.push(encodeFrame(frame));
    }

    private response(request: Frame, payload = new Uint8Array(), more = false): void {
        this.send({
            type: request.type,
            flags: (FrameFlag.RESPONSE | (more ? FrameFlag.MORE : 0)) as FrameFlag,
            requestId: request.requestId,
            payload,
        });
    }

    private hello(request: Frame): void {
        const fixed = new Uint8Array(28);
        const view = new DataView(fixed.buffer);
        fixed[0] = 1;
        fixed[1] = FileSystemState.MOUNTED;
        fixed[2] = RuntimeState.STOPPED;
        fixed[3] = BootFlag.WDT1_RECOVERY;
        view.setUint32(4, 0xff | CAP_BOOT_FLAGS | CAP_CAMERA, true);
        view.setUint16(8, 1024, true);
        view.setUint16(10, 1016, true);
        view.setUint16(12, 63, true);
        view.setUint16(14, 65535, true);
        view.setUint32(16, 256 * 1024, true);
        view.setUint32(20, 1024 * 1024, true);
        view.setUint32(24, Array.from(this.files.values()).reduce((sum, file) => sum + file.length, 0), true);
        this.response(request, concatBytes(fixed, packName('0.5.0'), packName(this.board)));
    }

    private handle(request: Frame): void {
        const view = new DataView(
            request.payload.buffer,
            request.payload.byteOffset,
            request.payload.byteLength,
        );
        switch (request.type) {
            case MessageType.HELLO:
                this.hello(request);
                break;
            case MessageType.LIST: {
                const entries = Array.from(this.files.entries());
                entries.forEach(([name, bytes]) => {
                    this.response(request, concatBytes(packName(name), scalar(4, bytes.length)), true);
                });
                this.response(request);
                break;
            }
            case MessageType.STAT: {
                const [name] = parseName(request.payload);
                const bytes = this.files.get(name) ?? new Uint8Array();
                this.response(request, concatBytes(scalar(4, bytes.length), Uint8Array.of(name === this.startup ? 1 : 0)));
                break;
            }
            case MessageType.READ: {
                const [name, offset] = parseName(request.payload);
                const start = view.getUint32(offset, true);
                const requested = view.getUint32(offset + 4, true);
                const bytes = this.files.get(name) ?? new Uint8Array();
                const end = requested === 0 ? bytes.length : Math.min(bytes.length, start + requested);
                this.response(request, concatBytes(scalar(4, start), scalar(4, bytes.length), bytes.slice(start, end)));
                break;
            }
            case MessageType.UPLOAD_BEGIN: {
                const [name, offset] = parseName(request.payload);
                const size = view.getUint32(offset, true);
                this.upload = { id: 41, name, bytes: new Uint8Array(size) };
                this.response(request, concatBytes(scalar(4, 41), scalar(4, 0)));
                break;
            }
            case MessageType.UPLOAD_CHUNK: {
                const id = view.getUint32(0, true);
                const offset = view.getUint32(4, true);
                const data = request.payload.subarray(8);
                expect(this.upload?.id).toBe(id);
                this.upload?.bytes.set(data, offset);
                this.response(request, concatBytes(scalar(4, id), scalar(4, offset + data.length)));
                break;
            }
            case MessageType.UPLOAD_COMMIT:
                expect(this.upload?.id).toBe(view.getUint32(0, true));
                if (this.upload) {
                    this.files.set(this.upload.name, this.upload.bytes);
                    this.upload = undefined;
                }
                this.response(request);
                break;
            case MessageType.UPLOAD_ABORT:
                this.upload = undefined;
                this.response(request);
                break;
            case MessageType.SET_STARTUP: {
                const [name] = parseName(request.payload);
                this.startup = name;
                this.response(request);
                break;
            }
            case MessageType.RUN: {
                this.runId += 1;
                this.response(request, scalar(4, this.runId));
                this.send({
                    type: MessageType.STDOUT,
                    flags: 0 as FrameFlag,
                    requestId: 0,
                    payload: concatBytes(scalar(4, this.runId), scalar(4, 0), encoder.encode('MP_OK\n')),
                });
                break;
            }
            case MessageType.STATUS: {
                const status = new Uint8Array(52);
                const statusView = new DataView(status.buffer);
                status[0] = this.runId ? RuntimeState.RUNNING : RuntimeState.STOPPED;
                status[2] = FileSystemState.MOUNTED;
                statusView.setUint32(4, this.runId, true);
                statusView.setUint32(44, 1024 * 1024, true);
                statusView.setUint32(48, Array.from(this.files.values()).reduce((sum, file) => sum + file.length, 0), true);
                this.response(request, status);
                break;
            }
            case MessageType.STOP:
                this.runId = 0;
                this.response(request);
                break;
            case MessageType.DELETE: {
                const [name] = parseName(request.payload);
                this.files.delete(name);
                if (this.startup === name) {
                    this.startup = '';
                }
                this.response(request);
                break;
            }
            case MessageType.PING:
                this.pingRequests += 1;
                this.response(request, request.payload);
                break;
            case MessageType.FORMAT:
                setTimeout(() => this.response(request), this.formatDelayMs);
                break;
            case MessageType.SESSION_CLOSE:
                this.response(request);
                break;
            case MessageType.CAMERA: {
                const mode = request.payload[0];
                if (mode === 2) {
                    this.response(request);
                    break;
                }
                const width = mode ? 120 : 72;
                const height = mode ? 160 : 96;
                const pixels = new Uint8Array(width * height * (mode + 1));
                pixels.set(mode ? [0x00, 0xf8, 0xe0, 0x07, 0x1f, 0x00] : [0xe0, 0x1c, 0x03]);
                for (let offset = 0; offset < pixels.length; offset += 383) {
                    this.response(request, concatBytes(
                        scalar(2, width), scalar(2, height),
                        scalar(4, offset + (this.badCameraOffset && offset > 0 ? 1 : 0)),
                        pixels.subarray(offset, offset + 383),
                    ), offset + 383 < pixels.length);
                }
                break;
            }
            default:
                throw new Error(`unhandled fake request ${request.type}`);
        }
    }

    public read(): Promise<Uint8Array | null> {
        const queued = this.queue.shift();
        if (queued) {
            return Promise.resolve(queued);
        }
        if (this.closed) {
            return Promise.resolve(null);
        }
        return new Promise((resolve) => this.readers.push(resolve));
    }

    public async write(data: Uint8Array): Promise<void> {
        if (equalBytes(data, LINE_HANDSHAKE)) {
            this.handshakeWrites += 1;
            if (!this.readyScheduled && this.readyDelayMs !== null) {
                this.readyScheduled = true;
                if (this.readyDelayMs === 0) {
                    this.push(encoder.encode('HKMPROTO 1 READY\n'));
                } else {
                    for (let elapsed = 1000; elapsed < this.readyDelayMs; elapsed += 1000) {
                        setTimeout(() => this.push(encoder.encode(`boot ${elapsed}\r\n`)), elapsed);
                    }
                    setTimeout(
                        () => this.push(encoder.encode('boot complete\r\nHKMPROTO 1 READY\n')),
                        this.readyDelayMs,
                    );
                }
            }
            return;
        }
        this.handle(decodeFrame(data));
    }

    public async close(): Promise<void> {
        this.closeCalls += 1;
        this.closed = true;
        for (const reader of this.readers.splice(0)) {
            reader(null);
        }
    }
}

class StalledHandshakeTransport implements ByteTransport {
    public handshakeWrites = 0;
    public closeCalls = 0;

    public read(): Promise<Uint8Array | null> {
        return new Promise(() => undefined);
    }

    public write(data: Uint8Array): Promise<void> {
        if (!equalBytes(data, LINE_HANDSHAKE)) {
            return Promise.reject(new Error('unexpected framed write before READY'));
        }
        this.handshakeWrites += 1;
        return new Promise(() => undefined);
    }

    public close(): Promise<void> {
        this.closeCalls += 1;
        // WebSerialTransport.close() waits for its write tail. Model a writer
        // that never accepts the first handshake probe.
        return new Promise(() => undefined);
    }
}

describe('HMPY browser client', () => {
    test('assembles portrait preview and snapshot chunks and rejects discontinuities', async () => {
        const device = new FakeDevice();
        const client = new HmpyClient(device);
        await client.open();
        try {
            expect((await client.hello()).capabilities & CAP_CAMERA).toBe(CAP_CAMERA);
            for (const snapshot of [false, true]) {
                const frame = await client.cameraFrame(snapshot);
                expect(frame.width).toBe(snapshot ? 120 : 72);
                expect(frame.height).toBe(snapshot ? 160 : 96);
                expect(Array.from(frame.pixels.subarray(0, 12))).toEqual([
                    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
                ]);
            }
            await client.stopCamera();
            device.badCameraOffset = true;
            await expect(client.cameraFrame()).rejects.toThrow('смещение');
        } finally {
            await client.close();
        }
    });

    test.each([
        ['huskylens-sen0305', 320],
        ['sipeed-maix-cube', 240],
    ])('completes the storage and runtime workflow on %s', async (board, width) => {
        const events: HmpyEvent[] = [];
        const client = new HmpyClient(new FakeDevice(0, 0, board), { onEvent: (event) => events.push(event) });
        await client.open();
        const hello = await client.hello();
        expect(hello.sourceMax).toBe(65535);
        expect(hello.board).toBe(board);
        expect(boardProfile(hello.board)).toMatchObject({ width, height: 240 });
        expect(hello.bootFlags).toBe(BootFlag.WDT1_RECOVERY);
        expect(hello.capabilities & CAP_BOOT_FLAGS).toBe(CAP_BOOT_FLAGS);

        const source = encoder.encode('print("MP_OK")\n');
        await client.upload('main.py', source);
        expect((await client.listFiles()).map((file) => file.name)).toEqual(['main.py']);
        expect(await client.readFile('main.py')).toEqual(source);
        await client.setStartup('main.py');
        expect((await client.stat('main.py')).startup).toBe(true);

        expect(await client.run('main.py')).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(new TextDecoder().decode(events[0].data)).toBe('MP_OK\n');
        expect((await client.status()).runtimeState).toBe(RuntimeState.RUNNING);
        await client.stop();
        expect((await client.status()).runtimeState).toBe(RuntimeState.STOPPED);

        await client.delete('main.py');
        expect(await client.listFiles()).toEqual([]);
        await client.close();
        expect(client.isOpen).toBe(false);
    });

    test('does not inject keepalive into a long pending operation', async () => {
        const device = new FakeDevice(3200);
        const client = new HmpyClient(device);
        await client.open();
        await client.formatUserfs('ERASE USERFS');
        expect(device.pingRequests).toBe(0);
        await client.close();
    }, 10_000);

    test('retries through a five-second reset independently of request timeout and stops at READY', async () => {
        jest.useFakeTimers();
        try {
            const device = new FakeDevice(0, 5000);
            const client = new HmpyClient(device, { requestTimeoutMs: 5 });
            const opening = client.open();

            await jest.advanceTimersByTimeAsync(4999);
            expect(client.isOpen).toBe(false);
            expect(device.handshakeWrites).toBeGreaterThan(1);

            await jest.advanceTimersByTimeAsync(1);
            await opening;
            expect(client.isOpen).toBe(true);

            const handshakesAtReady = device.handshakeWrites;
            await jest.advanceTimersByTimeAsync(1000);
            expect(device.handshakeWrites).toBe(handshakesAtReady);

            await client.close();
        } finally {
            jest.useRealTimers();
        }
    });

    test('accepts READY immediately before the handshake deadline without another probe', async () => {
        jest.useFakeTimers();
        try {
            const device = new FakeDevice(0, 7999);
            const client = new HmpyClient(device, { requestTimeoutMs: 1 });
            const opening = client.open();

            await jest.advanceTimersByTimeAsync(7999);
            await opening;
            expect(client.isOpen).toBe(true);

            const handshakesAtReady = device.handshakeWrites;
            await jest.advanceTimersByTimeAsync(1000);
            expect(device.handshakeWrites).toBe(handshakesAtReady);
            await client.close();
        } finally {
            jest.useRealTimers();
        }
    });

    test('bounds handshake retries at eight seconds', async () => {
        jest.useFakeTimers();
        try {
            const device = new FakeDevice(0, null);
            const client = new HmpyClient(device);
            const opening = expect(client.open()).rejects.toBeInstanceOf(HmpyTimeout);

            await jest.advanceTimersByTimeAsync(8000);
            await opening;

            expect(device.handshakeWrites).toBeGreaterThan(1);
            expect(device.handshakeWrites).toBeLessThanOrEqual(24);
            expect(device.closeCalls).toBe(1);

            const finalHandshakeCount = device.handshakeWrites;
            await jest.advanceTimersByTimeAsync(1000);
            expect(device.handshakeWrites).toBe(finalHandshakeCount);
        } finally {
            jest.useRealTimers();
        }
    });

    test('keeps the eight-second deadline when the write and close paths are stalled', async () => {
        jest.useFakeTimers();
        try {
            const transport = new StalledHandshakeTransport();
            const client = new HmpyClient(transport, { requestTimeoutMs: 1 });
            const opening = expect(client.open()).rejects.toBeInstanceOf(HmpyTimeout);

            await jest.advanceTimersByTimeAsync(7999);
            expect(transport.closeCalls).toBe(0);
            await jest.advanceTimersByTimeAsync(1);
            await opening;

            expect(transport.handshakeWrites).toBe(1);
            expect(transport.closeCalls).toBe(1);
            const writesAtDeadline = transport.handshakeWrites;
            await jest.advanceTimersByTimeAsync(1000);
            expect(transport.handshakeWrites).toBe(writesAtDeadline);
        } finally {
            jest.useRealTimers();
        }
    });
});
