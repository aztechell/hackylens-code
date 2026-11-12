// SPDX-License-Identifier: MIT

import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react/pure';
import { CameraPanel } from './CameraPanel';
import type { CameraFrame, HmpyClient } from './client';

// JSDOM only needs canvas element events. Draw calls are stubbed below.
jest.mock('canvas', () => ({}));
const { JSDOM } = require('jsdom') as {
    JSDOM: new (html: string, options: { pretendToBeVisual: boolean }) => { window: Window & typeof globalThis };
};

test('copies a Python threshold from the selected region of a snapshot', async () => {
    const { window } = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
    const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.assign(globalThis, { window, document: window.document });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator });
    const frame: CameraFrame = {
        width: 3,
        height: 1,
        format: 'rgb565',
        pixels: new Uint8ClampedArray([0, 0, 255, 255, 255, 0, 0, 255, 247, 4, 0, 255]),
    };
    const cameraFrame = jest.fn().mockResolvedValue(frame);
    const stopCamera = jest.fn().mockResolvedValue(undefined);
    const client = { isOpen: true, hasPendingRequests: false, cameraFrame, stopCamera } as unknown as HmpyClient;
    const copy = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    const context = jest.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData: jest.fn(),
        strokeRect: jest.fn(),
    } as unknown as CanvasRenderingContext2D);

    try {
        const screen = render(React.createElement(CameraPanel, { client, supported: true, busy: false }));
        fireEvent.click(screen.getByRole('button', { name: 'Снимок' }));
        const canvas = await screen.findByLabelText(/Кадр с камеры/);
        expect(cameraFrame).toHaveBeenCalledWith(true);
        expect(stopCamera).toHaveBeenCalledTimes(1);
        canvas.getBoundingClientRect = () => ({
            x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100,
            toJSON: () => ({}),
        });
        Object.defineProperty(canvas, 'setPointerCapture', { value: jest.fn() });
        const pointer = (type: string, clientX: number) => {
            const event = new window.MouseEvent(type, { bubbles: true, button: 0, clientX, clientY: 50 });
            Object.defineProperty(event, 'pointerId', { value: 1 });
            fireEvent(canvas, event);
        };
        pointer('pointerdown', 150);
        pointer('pointerup', 250);

        const threshold = '(29, 31, 0, 2, 0, 1)';
        expect((screen.getByLabelText('Порог RGB565') as HTMLInputElement).value).toBe(threshold);
        fireEvent.click(screen.getByRole('button', { name: 'Копировать порог' }));
        await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Порог скопирован'));
        expect(copy).toHaveBeenCalledWith(threshold);
    } finally {
        cleanup();
        context.mockRestore();
        window.close();
        Reflect.deleteProperty(globalThis, 'window');
        Reflect.deleteProperty(globalThis, 'document');
        if (navigatorBefore) {
            Object.defineProperty(globalThis, 'navigator', navigatorBefore);
        } else {
            Reflect.deleteProperty(globalThis, 'navigator');
        }
    }
});
