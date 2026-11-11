// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState } from 'react';
import { ErrorCode, HmpyRemoteError } from './client';
import type { CameraFrame, HmpyClient } from './client';

interface Props {
    readonly client?: HmpyClient;
    readonly supported: boolean;
    readonly busy: boolean;
}

type Mode = 'live' | 'snapshot';

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
    const canvas = useRef<HTMLCanvasElement>(null);
    const requested = useRef(false);

    useEffect(() => {
        const change = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', change);
        return () => document.removeEventListener('visibilitychange', change);
    }, []);

    useEffect(() => {
        setMode(undefined);
        setFrame(undefined);
        setError('');
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
        if (frame && context) {
            const image = context.createImageData(frame.width, frame.height);
            image.data.set(frame.pixels);
            context.putImageData(image, 0, 0);
        }
    }, [frame]);

    const start = (next: Mode) => {
        setError('');
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
        canvas.current?.toBlob((blob) => {
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

    const available = Boolean(client && supported && !busy);
    return (
        <section className="camera-card panel" aria-label="Превью камеры">
            <div className="panel-heading compact">
                <div><span className="eyebrow">HMPY</span><h2>Камера</h2></div>
                {frame && <span className="camera-size">{frame.width} × {frame.height}</span>}
            </div>
            <div className="camera-image">
                {frame
                    ? <canvas ref={canvas} width={frame.width} height={frame.height} aria-label="Кадр с камеры" />
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
                <button type="button" className="button ghost small" onClick={save} disabled={!frame}>Скачать PNG</button>
            </div>
        </section>
    );
};
