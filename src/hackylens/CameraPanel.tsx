// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState } from 'react';
import { cameraPoint, cameraRegion, rgb565Threshold } from './cameraColor';
import type { CameraRegion } from './cameraColor';
import { ErrorCode, HmpyRemoteError } from './client';
import type { CameraFrame, HmpyClient } from './client';

interface Props {
    readonly client?: HmpyClient;
    readonly supported: boolean;
    readonly busy: boolean;
}

type Mode = 'live' | 'snapshot';

function drawFrame(context: CanvasRenderingContext2D, frame: CameraFrame): void {
    const image = context.createImageData(frame.width, frame.height);
    image.data.set(frame.pixels);
    context.putImageData(image, 0, 0);
}

function releaseCamera(client: HmpyClient): void {
    if (client.isOpen) {
        void client.stopCamera().catch(() => undefined);
    }
}

export const CameraPanel: React.FC<Props> = ({ client, supported, busy }) => {
    const [mode, setMode] = useState<Mode>();
    const [frame, setFrame] = useState<CameraFrame>();
    const [error, setError] = useState('');
    const [visible, setVisible] = useState(!document.hidden);
    const [selection, setSelection] = useState<{ frame: CameraFrame; region: CameraRegion }>();
    const [threshold, setThreshold] = useState('');
    const [copyStatus, setCopyStatus] = useState('');
    const canvas = useRef<HTMLCanvasElement>(null);
    const drag = useRef<{ id: number; x: number; y: number; frame: CameraFrame }>();
    const requested = useRef(false);
    const shownFrame = selection?.frame ?? frame;

    useEffect(() => {
        const change = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', change);
        return () => document.removeEventListener('visibilitychange', change);
    }, []);

    useEffect(() => {
        setMode(undefined);
        setFrame(undefined);
        setError('');
        setSelection(undefined);
        setThreshold('');
        setCopyStatus('');
        drag.current = undefined;
        return () => {
            if (client && requested.current) {
                releaseCamera(client);
                requested.current = false;
            }
        };
    }, [client]);

    useEffect(() => {
        if (!mode || !client?.isOpen || !supported || busy || !visible) {
            return undefined;
        }
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        let pendingSince: number | undefined;
        const next = async (): Promise<void> => {
            if (cancelled || !client.isOpen) {
                return;
            }
            if (client.hasPendingRequests) {
                timer = setTimeout(next, 100);
                return;
            }
            requested.current = true;
            try {
                const image = await client.cameraFrame(mode === 'snapshot');
                if (cancelled) {
                    return;
                }
                setFrame(image);
                pendingSince = undefined;
                if (mode === 'snapshot') {
                    setMode(undefined);
                    releaseCamera(client);
                    requested.current = false;
                    return;
                }
            } catch (failure) {
                if (cancelled) {
                    return;
                }
                pendingSince ??= Date.now();
                const retry = failure instanceof HmpyRemoteError && failure.code === ErrorCode.BUSY &&
                    ['camera frame pending', 'camera transfer in progress', 'camera transfer cancelled', 'read in progress'].includes(failure.detail) &&
                    Date.now() - pendingSince < 4000;
                if (!retry) {
                    setError(failure instanceof HmpyRemoteError && failure.detail === 'open menu or camera'
                        ? 'Откройте на плате главное меню или приложение камеры и повторите.'
                        : failure instanceof Error ? failure.message : String(failure));
                    setMode(undefined);
                    releaseCamera(client);
                    requested.current = false;
                    return;
                }
            }
            timer = setTimeout(next, 120);
        };
        timer = setTimeout(next, 0);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [busy, client, mode, supported, visible]);

    useEffect(() => {
        const context = canvas.current?.getContext('2d');
        if (shownFrame && context) {
            drawFrame(context, shownFrame);
            if (selection) {
                const { x, y, width, height } = selection.region;
                context.strokeStyle = '#fff';
                context.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
            }
        }
    }, [shownFrame, selection]);

    const start = (next: Mode) => {
        setError('');
        setSelection(undefined);
        setThreshold('');
        setCopyStatus('');
        drag.current = undefined;
        setMode(next);
    };
    const stop = () => {
        setMode(undefined);
        if (client && requested.current) {
            releaseCamera(client);
            requested.current = false;
        }
    };
    const save = () => {
        if (!shownFrame) {
            return;
        }
        const image = document.createElement('canvas');
        image.width = shownFrame.width;
        image.height = shownFrame.height;
        const context = image.getContext('2d');
        if (!context) {
            return;
        }
        drawFrame(context, shownFrame);
        image.toBlob((blob) => {
            if (!blob) {
                return;
            }
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `hackylens-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, 'image/png');
    };

    const startSelection = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!shownFrame || event.button !== 0) {
            return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        const point = cameraPoint(event.clientX - bounds.left, event.clientY - bounds.top, bounds, shownFrame);
        if (!point) {
            return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, ...point, frame: shownFrame };
        setSelection({ frame: shownFrame, region: cameraRegion(point, point) });
        setThreshold('');
        setCopyStatus('');
        stop();
    };
    const moveSelection = (event: React.PointerEvent<HTMLCanvasElement>, finish: boolean) => {
        const from = drag.current;
        if (!from || from.id !== event.pointerId) {
            return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        const to = cameraPoint(event.clientX - bounds.left, event.clientY - bounds.top, bounds, from.frame, true);
        if (to) {
            const region = cameraRegion(from, to);
            setSelection({ frame: from.frame, region });
            if (finish) {
                setThreshold(`(${rgb565Threshold(from.frame, region).join(', ')})`);
            }
        }
        if (finish) {
            drag.current = undefined;
        }
    };
    const copyThreshold = async () => {
        try {
            await navigator.clipboard.writeText(threshold);
            setCopyStatus('Порог скопирован');
        } catch {
            setCopyStatus('Выделите порог и скопируйте вручную');
        }
    };

    const available = Boolean(client && supported && !busy);
    return (
        <section className="camera-card panel" aria-label="Превью камеры">
            <div className="panel-heading compact">
                <div><span className="eyebrow">HMPY</span><h2>Камера</h2></div>
                {shownFrame && <span className="camera-size">{shownFrame.width} × {shownFrame.height}</span>}
            </div>
            <div className="camera-image">
                {shownFrame
                    ? <canvas ref={canvas} width={shownFrame.width} height={shownFrame.height}
                        aria-label="Кадр с камеры. Выделите область для подбора цвета."
                        onPointerDown={startSelection}
                        onPointerMove={(event) => moveSelection(event, false)}
                        onPointerUp={(event) => moveSelection(event, true)}
                        onLostPointerCapture={() => { drag.current = undefined; }} />
                    : <p className="empty-state">{!client ? 'Подключите плату по USB.' : !supported
                        ? 'Для превью нужна прошивка с поддержкой камеры в IDE.'
                        : mode ? 'Получаем кадр…' : 'Запустите превью или сделайте снимок.'}</p>}
            </div>
            {error && <p className="camera-error" role="alert">{error}</p>}
            <div className="camera-actions">
                <button type="button" className="button ghost small" onClick={mode ? stop : () => start('live')}
                    disabled={!mode && !available}>{mode ? 'Остановить' : '▶ Превью'}</button>
                <button type="button" className="button ghost small" onClick={() => start('snapshot')}
                    disabled={!available || mode === 'snapshot'}>Снимок</button>
                <button type="button" className="button ghost small" onClick={save} disabled={!shownFrame}>Скачать PNG</button>
            </div>
            {shownFrame && <div className="camera-threshold">
                {threshold
                    ? <>
                        <label>Порог RGB565<input readOnly value={threshold} onFocus={(event) => event.target.select()} /></label>
                        <button type="button" className="button ghost small" onClick={copyThreshold}>Копировать порог</button>
                        {copyStatus && <span role="status">{copyStatus}</span>}
                    </>
                    : <span>Выделите на кадре участок нужного цвета.</span>}
            </div>}
        </section>
    );
};
