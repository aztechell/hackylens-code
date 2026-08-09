// SPDX-License-Identifier: MIT

export interface ByteTransport {
    read(): Promise<Uint8Array | null>;
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
}

interface SerialPortLike {
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
    open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
    setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
    close(): Promise<void>;
}

interface SerialApiLike {
    requestPort(options?: { filters?: readonly Record<string, number>[] }): Promise<SerialPortLike>;
}

function serialApi(): SerialApiLike {
    const serial = (navigator as Navigator & { serial?: SerialApiLike }).serial;
    if (!serial) {
        throw new Error('Web Serial недоступен. Откройте IDE в Chrome/Edge через HTTPS или localhost.');
    }
    return serial;
}

export class WebSerialTransport implements ByteTransport {
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
    private writeTail: Promise<void> = Promise.resolve();
    private closed = false;

    private constructor(private readonly port: SerialPortLike) {
        if (!port.readable || !port.writable) {
            throw new Error('Последовательный порт не открыл потоки чтения/записи.');
        }
        this.reader = port.readable.getReader();
        this.writer = port.writable.getWriter();
    }

    public static async request(baudRate = 115200): Promise<WebSerialTransport> {
        const port = await serialApi().requestPort();
        let opened = false;
        try {
            await port.open({ baudRate, bufferSize: 4096 });
            opened = true;
            if (typeof port.setSignals === 'function') {
                await port.setSignals({ dataTerminalReady: false, requestToSend: false });
            }
            return new WebSerialTransport(port);
        } catch (error) {
            if (opened) {
                try {
                    await port.close();
                } catch {
                    // Preserve the setup failure when best-effort cleanup fails.
                }
            }
            throw error;
        }
    }

    public async read(): Promise<Uint8Array | null> {
        if (this.closed) {
            return null;
        }
        const result = await this.reader.read();
        return result.done ? null : (result.value ?? new Uint8Array());
    }

    public write(data: Uint8Array): Promise<void> {
        if (this.closed) {
            return Promise.reject(new Error('Последовательный порт закрыт.'));
        }
        const copy = data.slice();
        const next = this.writeTail.then(() => this.writer.write(copy));
        this.writeTail = next.catch(() => undefined);
        return next;
    }

    public async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        try {
            await this.reader.cancel();
        } catch {
            // The device may already have disappeared.
        }
        try {
            await this.writeTail;
        } catch {
            // Preserve the original disconnect path.
        }
        this.reader.releaseLock();
        try {
            await this.writer.close();
        } catch {
            // A physically disconnected writer cannot be closed cleanly.
        }
        this.writer.releaseLock();
        try {
            await this.port.close();
        } catch {
            // Port closure is best-effort after an unplug.
        }
    }
}
