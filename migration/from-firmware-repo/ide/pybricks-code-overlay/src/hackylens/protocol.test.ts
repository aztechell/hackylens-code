// SPDX-License-Identifier: MIT

import {
    CodecStatus,
    FrameFlag,
    MessageType,
    ProtocolError,
    StreamDecoder,
    decodeFrame,
    encodeFrame,
} from './protocol';

function hex(value: string): Uint8Array {
    const pairs = value.match(/../g) ?? [];
    return Uint8Array.from(pairs.map((pair) => Number.parseInt(pair, 16)));
}

function asHex(value: Uint8Array): string {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('HMPY codec', () => {
    test('matches the shared HELLO golden vector', () => {
        const wire = encodeFrame({
            type: MessageType.HELLO,
            flags: 0,
            requestId: 1,
            payload: new Uint8Array(),
        });
        expect(asHex(wire)).toBe('07484d5059010101020101010101010105a44eb6b800');
        expect(decodeFrame(wire)).toEqual({
            type: MessageType.HELLO,
            flags: 0,
            requestId: 1,
            payload: new Uint8Array(),
        });
    });

    test('preserves embedded zero bytes', () => {
        const wire = encodeFrame({
            type: MessageType.UPLOAD_CHUNK,
            flags: 0,
            requestId: 0x12345678,
            payload: hex('000100ff102000'),
        });
        expect(asHex(wire)).toBe(
            '07484d5059011101067856341207010101020104ff102005f17afc4f00',
        );
        expect(asHex(decodeFrame(wire).payload)).toBe('000100ff102000');
    });

    test('resynchronizes after an oversized packet', () => {
        const decoder = new StreamDecoder();
        const valid = encodeFrame({
            type: MessageType.PING,
            flags: 0,
            requestId: 9,
            payload: hex('0102'),
        });
        const oversized = new Uint8Array(1100).fill(1);
        const events = decoder.feed(new Uint8Array([...oversized, 0, ...valid]));
        expect(events).toHaveLength(2);
        expect(events[0].error?.status).toBe(CodecStatus.ENCODED_TOO_LARGE);
        expect(events[1].frame?.requestId).toBe(9);
    });

    test('rejects an error flag on a request', () => {
        expect(() => encodeFrame({
            type: MessageType.STAT,
            flags: FrameFlag.ERROR,
            requestId: 3,
            payload: new Uint8Array(),
        })).toThrow(ProtocolError);
    });
});
