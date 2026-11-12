import { cameraPoint, cameraRegion, rgb565Threshold } from './cameraColor';

test('maps a portrait frame inside a letterboxed canvas and clips the drag', () => {
    const frame = { width: 120, height: 160 };
    const bounds = { width: 250, height: 200 };
    expect(cameraPoint(49, 100, bounds, frame)).toBeUndefined();
    expect(cameraPoint(50, 0, bounds, frame)).toEqual({ x: 0, y: 0 });
    expect(cameraPoint(200, 200, bounds, frame, true)).toEqual({ x: 119, y: 159 });
    expect(cameraRegion({ x: 8, y: 9 }, { x: 2, y: 4 })).toEqual({
        x: 2, y: 4, width: 7, height: 6,
    });
});

test('derives a firmware-native threshold from only the selected pixels', () => {
    const frame = {
        width: 3, height: 1, format: 'rgb565' as const,
        pixels: new Uint8ClampedArray([0, 0, 255, 255, 255, 0, 0, 255, 247, 4, 0, 255]),
    };
    expect(rgb565Threshold(frame, { x: 1, y: 0, width: 2, height: 1 }))
        .toEqual([29, 31, 0, 2, 0, 1]);
});

test('includes all RGB565 values represented by a live RGB332 pixel', () => {
    const frame = {
        width: 1, height: 1, format: 'rgb332' as const,
        pixels: new Uint8ClampedArray([255, 109, 85, 255]),
    };
    expect(rgb565Threshold(frame, { x: 0, y: 0, width: 1, height: 1 }))
        .toEqual([27, 31, 23, 32, 7, 16]);
});
