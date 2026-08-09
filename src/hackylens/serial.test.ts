// SPDX-License-Identifier: MIT

import { WebSerialTransport } from './serial';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

interface FakePort {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
    setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
    close(): Promise<void>;
}

function installSerial(port: FakePort, events: string[]): void {
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            serial: {
                requestPort: async () => {
                    events.push('request');
                    return port;
                },
            },
        },
    });
}

function makePort(events: string[], supportsSignals: boolean): {
    port: FakePort;
    open: jest.Mock;
    close: jest.Mock;
    setSignals?: jest.Mock;
} {
    const reader = {
        read: jest.fn(async () => ({ done: true, value: undefined })),
        cancel: jest.fn(async () => undefined),
        releaseLock: jest.fn(),
    };
    const writer = {
        write: jest.fn(async () => undefined),
        close: jest.fn(async () => undefined),
        releaseLock: jest.fn(),
    };
    const readable = {
        getReader: () => {
            events.push('reader');
            return reader;
        },
    } as unknown as ReadableStream<Uint8Array>;
    const writable = {
        getWriter: () => {
            events.push('writer');
            return writer;
        },
    } as unknown as WritableStream<Uint8Array>;
    const open = jest.fn(async () => {
        events.push('open');
    });
    const close = jest.fn(async () => undefined);
    const port: FakePort = {
        get readable() {
            events.push('readable');
            return readable;
        },
        get writable() {
            events.push('writable');
            return writable;
        },
        open,
        close,
    };
    let setSignals: jest.Mock | undefined;
    if (supportsSignals) {
        setSignals = jest.fn(async () => {
            events.push('signals');
        });
        port.setSignals = setSignals;
    }
    return { port, open, close, setSignals };
}

afterEach(() => {
    if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
        Reflect.deleteProperty(globalThis, 'navigator');
    }
});

describe('WebSerialTransport', () => {
    test('deasserts DTR and RTS after open and before acquiring streams', async () => {
        const events: string[] = [];
        const { port, open, setSignals } = makePort(events, true);
        installSerial(port, events);

        const transport = await WebSerialTransport.request(230400);

        expect(open).toHaveBeenCalledWith({ baudRate: 230400, bufferSize: 4096 });
        expect(setSignals).toHaveBeenCalledWith({
            dataTerminalReady: false,
            requestToSend: false,
        });
        expect(events).toEqual([
            'request',
            'open',
            'signals',
            'readable',
            'writable',
            'readable',
            'reader',
            'writable',
            'writer',
        ]);

        await transport.close();
    });

    test('supports Web Serial implementations without setSignals', async () => {
        const events: string[] = [];
        const { port } = makePort(events, false);
        installSerial(port, events);

        const transport = await WebSerialTransport.request();

        expect(events).not.toContain('signals');
        expect(events.indexOf('open')).toBeLessThan(events.indexOf('reader'));
        await transport.close();
    });

    test('closes an opened port if optional signal setup fails', async () => {
        const events: string[] = [];
        const { port, close, setSignals } = makePort(events, true);
        const failure = new Error('control signals unavailable');
        setSignals?.mockRejectedValueOnce(failure);
        installSerial(port, events);

        await expect(WebSerialTransport.request()).rejects.toBe(failure);

        expect(close).toHaveBeenCalledTimes(1);
        expect(events).not.toContain('reader');
        expect(events).not.toContain('writer');
    });
});
