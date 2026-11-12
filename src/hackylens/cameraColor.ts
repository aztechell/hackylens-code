// SPDX-License-Identifier: MIT

import type { CameraFrame } from './client';

interface Point {
    readonly x: number;
    readonly y: number;
}

export interface CameraRegion {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export function cameraPoint(
    x: number,
    y: number,
    bounds: { readonly width: number; readonly height: number },
    frame: Pick<CameraFrame, 'width' | 'height'>,
    clamp = false,
): Point | undefined {
    const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height);
    if (scale <= 0) {
        return undefined;
    }
    const left = (bounds.width - frame.width * scale) / 2;
    const top = (bounds.height - frame.height * scale) / 2;
    const px = Math.floor((x - left) / scale);
    const py = Math.floor((y - top) / scale);
    if (!clamp && (px < 0 || py < 0 || px >= frame.width || py >= frame.height)) {
        return undefined;
    }
    return {
        x: Math.min(frame.width - 1, Math.max(0, px)),
        y: Math.min(frame.height - 1, Math.max(0, py)),
    };
}

export function cameraRegion(from: Point, to: Point): CameraRegion {
    return {
        x: Math.min(from.x, to.x),
        y: Math.min(from.y, to.y),
        width: Math.abs(from.x - to.x) + 1,
        height: Math.abs(from.y - to.y) + 1,
    };
}

function percentile(histogram: Uint32Array, index: number): number {
    let remaining = index;
    for (let bin = 0; bin < histogram.length; bin++) {
        remaining -= histogram[bin];
        if (remaining < 0) {
            return bin;
        }
    }
    return histogram.length - 1;
}

export function rgb565Threshold(frame: CameraFrame, region: CameraRegion): number[] {
    const nativeBits = [5, 6, 5];
    const sourceBits = frame.format === 'rgb332' ? [3, 3, 2] : nativeBits;
    const histograms = sourceBits.map((bits) => new Uint32Array(1 << bits));
    for (let y = region.y; y < region.y + region.height; y++) {
        for (let x = region.x; x < region.x + region.width; x++) {
            const offset = (y * frame.width + x) * 4;
            histograms.forEach((histogram, channel) => {
                const bin = Math.round(frame.pixels[offset + channel] * (histogram.length - 1) / 255);
                histogram[bin]++;
            });
        }
    }

    const last = region.width * region.height - 1;
    return histograms.flatMap((histogram, channel) => {
        // RGB332 drops the low RGB565 bits. Include every native value
        // consistent with the observed bins, plus one native bin of margin.
        const step = 1 << (nativeBits[channel] - sourceBits[channel]);
        const low = percentile(histogram, Math.floor(last * 0.05)) * step;
        const high = (percentile(histogram, Math.ceil(last * 0.95)) + 1) * step - 1;
        return [Math.max(0, low - 1), Math.min((1 << nativeBits[channel]) - 1, high + 1)];
    });
}
