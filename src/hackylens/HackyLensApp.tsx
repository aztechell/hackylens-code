// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    BootFlag,
    CAP_BOOT_FLAGS,
    FILE_MAX,
    FORMAT_TOKEN,
    FileInfo,
    FileSystemState,
    HelloInfo,
    HmpyClient,
    HmpyEvent,
    RuntimeState,
    RuntimeStatus,
} from './client';
import { MessageType } from './protocol';
import { WebSerialTransport } from './serial';
import { MonacoEditor } from './MonacoEditor';
import './app.scss';

const DEFAULT_NAME = 'main.py';
const DEFAULT_SOURCE = `import hackylens as hl

hl.display_clear(0x0000)
hl.display_text(8, 8, "Hello from MicroPython", 0xffff, 0x0000)
hl.display_present()
hl.rgb(0, 48, 20)

for count in range(10):
    print("HackyLens", count)
    hl.sleep_ms(250)

hl.rgb(0, 0, 0)
`;

const runtimeNames: Record<number, string> = {
    [RuntimeState.STOPPED]: 'остановлен',
    [RuntimeState.STARTING]: 'запуск',
    [RuntimeState.RUNNING]: 'выполняется',
    [RuntimeState.STOPPING]: 'остановка',
    [RuntimeState.FINISHED]: 'завершён',
    [RuntimeState.ERROR]: 'ошибка',
};

const filesystemNames: Record<number, string> = {
    [FileSystemState.UNINITIALIZED]: 'не инициализирована',
    [FileSystemState.UNSUPPORTED_FLASH]: 'нужна flash 16 МиБ',
    [FileSystemState.UNFORMATTED]: 'не форматирована',
    [FileSystemState.CORRUPT]: 'повреждена',
    [FileSystemState.IO_ERROR]: 'ошибка ввода-вывода',
    [FileSystemState.MOUNTED]: 'готова',
};

function humanBytes(value: number): string {
    if (value < 1024) {
        return `${value} Б`;
    }
    if (value < 1024 * 1024) {
        return `${(value / 1024).toFixed(1)} КиБ`;
    }
    return `${(value / (1024 * 1024)).toFixed(2)} МиБ`;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export const HackyLensApp: React.FC = () => {
    const clientRef = useRef<HmpyClient>();
    const stdoutDecoderRef = useRef(new TextDecoder());
    const stderrDecoderRef = useRef(new TextDecoder());
    const logRef = useRef<HTMLPreElement>(null);
    const [connected, setConnected] = useState(false);
    const [hello, setHello] = useState<HelloInfo>();
    const [runtime, setRuntime] = useState<RuntimeStatus>();
    const [files, setFiles] = useState<FileInfo[]>([]);
    const [fileName, setFileName] = useState(DEFAULT_NAME);
    const [source, setSource] = useState(DEFAULT_SOURCE);
    const [savedSource, setSavedSource] = useState('');
    const [logs, setLogs] = useState('HackyLens Code готов к подключению.\n');
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');

    const sourceBytes = useMemo(() => new TextEncoder().encode(source).length, [source]);
    const dirty = source !== savedSource;
    const selected = files.find((file) => file.name === fileName);
    const mounted = hello?.filesystemState === FileSystemState.MOUNTED;
    const runnable = hello ? sourceBytes <= hello.sourceMax : sourceBytes <= 65535;

    const appendLog = useCallback((text: string) => {
        setLogs((previous) => (previous + text).slice(-100_000));
    }, []);

    const refreshFiles = useCallback(async (explicitClient?: HmpyClient) => {
        const client = explicitClient ?? clientRef.current;
        if (!client?.isOpen) {
            return;
        }
        const listed = await client.listFiles();
        const detailed: FileInfo[] = [];
        for (const file of listed) {
            try {
                detailed.push(await client.stat(file.name));
            } catch {
                // A FILE_CHANGED event may race this snapshot; the next refresh fixes it.
            }
        }
        detailed.sort((left, right) => left.name.localeCompare(right.name));
        setFiles(detailed);
    }, []);

    const handleEvent = useCallback((event: HmpyEvent) => {
        if (event.type === MessageType.STDOUT && event.data) {
            appendLog(stdoutDecoderRef.current.decode(event.data, { stream: true }));
        } else if (event.type === MessageType.STDERR && event.data) {
            appendLog(stderrDecoderRef.current.decode(event.data, { stream: true }));
        } else if (event.type === MessageType.DROPPED) {
            appendLog(`\n[потеряно ${event.droppedCount ?? 0} байт потока ${event.droppedStream ?? '?'}]\n`);
        } else if (event.type === MessageType.STATE) {
            appendLog(`\n[run ${event.runId ?? 0}: ${runtimeNames[event.state ?? -1] ?? 'состояние ?'}, exit=${event.exitReason ?? 0}]\n`);
            if (event.state === RuntimeState.STARTING) {
                stdoutDecoderRef.current = new TextDecoder();
                stderrDecoderRef.current = new TextDecoder();
            }
            const client = clientRef.current;
            if (client?.isOpen && !client.hasPendingRequests) {
                void client.status().then(setRuntime).catch(() => undefined);
            }
        } else if (event.type === MessageType.FILE_CHANGED) {
            const client = clientRef.current;
            if (client?.isOpen && !client.hasPendingRequests) {
                void refreshFiles(client).catch(() => undefined);
            }
        }
    }, [appendLog, refreshFiles]);

    const runBusy = useCallback(async (label: string, operation: () => Promise<void>) => {
        if (busy) {
            return;
        }
        setBusy(label);
        setError('');
        try {
            await operation();
        } catch (operationError) {
            const message = errorText(operationError);
            setError(message);
            appendLog(`\n[ошибка] ${message}\n`);
        } finally {
            setBusy('');
        }
    }, [appendLog, busy]);

    const connect = useCallback(() => runBusy('Подключение…', async () => {
        const transport = await WebSerialTransport.request();
        let nextClient: HmpyClient;
        nextClient = new HmpyClient(transport, {
            onEvent: handleEvent,
            onDisconnect: (disconnectError) => {
                if (clientRef.current === nextClient) {
                    clientRef.current = undefined;
                    setConnected(false);
                    setHello(undefined);
                    setRuntime(undefined);
                    setFiles([]);
                    if (disconnectError) {
                        setError(disconnectError.message);
                        appendLog(`\n[соединение закрыто] ${disconnectError.message}\n`);
                    }
                }
            },
        });
        clientRef.current = nextClient;
        try {
            await nextClient.open();
            const profile = await nextClient.hello();
            setHello(profile);
            setConnected(true);
            appendLog(`\n[подключено] ${profile.board}, firmware ${profile.firmwareVersion}, HMPY v${profile.protocolVersion}\n`);
            if ((profile.capabilities & CAP_BOOT_FLAGS) &&
                (profile.bootFlags & BootFlag.WDT1_RECOVERY)) {
                appendLog('[восстановление] Перезапуск WDT1; автоматический запуск MicroPython отключён до следующей загрузки.\n');
            }
            if (profile.filesystemState === FileSystemState.MOUNTED) {
                await refreshFiles(nextClient);
            } else {
                setFiles([]);
                appendLog(`[userfs] ${filesystemNames[profile.filesystemState] ?? profile.filesystemState}\n`);
            }
            setRuntime(await nextClient.status());
        } catch (connectError) {
            clientRef.current = undefined;
            await nextClient.close().catch(() => undefined);
            throw connectError;
        }
    }), [appendLog, handleEvent, refreshFiles, runBusy]);

    const disconnect = useCallback(() => runBusy('Отключение…', async () => {
        const client = clientRef.current;
        clientRef.current = undefined;
        if (client) {
            await client.close();
        }
        setConnected(false);
        setHello(undefined);
        setRuntime(undefined);
        setFiles([]);
        appendLog('\n[отключено]\n');
    }), [appendLog, runBusy]);

    const uploadCurrent = useCallback(async (client: HmpyClient): Promise<void> => {
        const bytes = new TextEncoder().encode(source);
        if (bytes.length > FILE_MAX || (hello && bytes.length > hello.fileMax)) {
            throw new Error('Исходник превышает файловый предел устройства.');
        }
        await client.upload(fileName, bytes);
        setSavedSource(source);
        await refreshFiles(client);
    }, [fileName, hello, refreshFiles, source]);

    const save = useCallback(() => runBusy('Сохранение…', async () => {
        const client = clientRef.current;
        if (!client || !mounted) {
            throw new Error('userfs не готова. При необходимости выполните форматирование.');
        }
        await uploadCurrent(client);
        appendLog(`[сохранено] ${fileName}, ${sourceBytes} байт\n`);
    }), [appendLog, fileName, mounted, runBusy, sourceBytes, uploadCurrent]);

    const run = useCallback(() => runBusy('Запуск…', async () => {
        const client = clientRef.current;
        if (!client || !mounted) {
            throw new Error('userfs не готова.');
        }
        if (!runnable) {
            throw new Error(`VM принимает не более ${hello?.sourceMax ?? 65535} байт исходника.`);
        }
        await uploadCurrent(client);
        const runId = await client.run(fileName);
        appendLog(`\n[запуск] ${fileName}, run ${runId}\n`);
        setRuntime(await client.status());
    }), [appendLog, fileName, hello?.sourceMax, mounted, runBusy, runnable, uploadCurrent]);

    const stop = useCallback(() => runBusy('Остановка…', async () => {
        const client = clientRef.current;
        if (!client) {
            return;
        }
        await client.stop();
        appendLog('\n[запрошена безопасная остановка]\n');
        setRuntime(await client.status());
    }), [appendLog, runBusy]);

    const openFile = useCallback((file: FileInfo) => runBusy('Чтение…', async () => {
        const client = clientRef.current;
        if (!client) {
            return;
        }
        const data = await client.readFile(file.name);
        let text: string;
        try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(data);
        } catch {
            throw new Error(`${file.name} не является UTF-8 MicroPython-файлом.`);
        }
        setFileName(file.name);
        setSource(text);
        setSavedSource(text);
    }), [runBusy]);

    const setStartup = useCallback(() => runBusy('Автозапуск…', async () => {
        const client = clientRef.current;
        if (!client || !mounted) {
            throw new Error('userfs не готова.');
        }
        if (!selected || dirty) {
            await uploadCurrent(client);
        }
        await client.setStartup(fileName);
        await refreshFiles(client);
        appendLog(`[автозапуск] ${fileName}\n`);
    }), [appendLog, dirty, fileName, mounted, refreshFiles, runBusy, selected, uploadCurrent]);

    const clearStartup = useCallback(() => runBusy('Автозапуск…', async () => {
        const client = clientRef.current;
        if (!client) {
            return;
        }
        await client.setStartup();
        await refreshFiles(client);
        appendLog('[автозапуск очищен]\n');
    }), [appendLog, refreshFiles, runBusy]);

    const removeFile = useCallback(() => runBusy('Удаление…', async () => {
        const client = clientRef.current;
        if (!client || !selected) {
            return;
        }
        if (!window.confirm(`Удалить ${selected.name}?`)) {
            return;
        }
        await client.delete(selected.name);
        await refreshFiles(client);
        setSavedSource('');
        appendLog(`[удалено] ${selected.name}\n`);
    }), [appendLog, refreshFiles, runBusy, selected]);

    const format = useCallback(() => runBusy('Форматирование…', async () => {
        const client = clientRef.current;
        if (!client) {
            return;
        }
        const confirmation = window.prompt(
            `Форматирование безвозвратно удалит все скрипты. Введите: ${FORMAT_TOKEN}`,
        );
        if (confirmation === null) {
            return;
        }
        await client.formatUserfs(confirmation);
        const profile = await client.hello();
        setHello(profile);
        await refreshFiles(client);
        setSavedSource('');
        appendLog('[userfs отформатирована]\n');
    }), [appendLog, refreshFiles, runBusy]);

    const newFile = useCallback(() => {
        const existingNames = new Set(files.map((file) => file.name));
        existingNames.add(fileName);
        let nextName = 'untitled.py';
        let suffix = 2;
        while (existingNames.has(nextName)) {
            nextName = `untitled-${suffix}.py`;
            suffix += 1;
        }
        setFileName(nextName);
        setSource(DEFAULT_SOURCE);
        setSavedSource('');
        setError('');
    }, [fileName, files]);

    useEffect(() => {
        if (!connected || busy) {
            return undefined;
        }
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            const client = clientRef.current;
            if (!cancelled && client?.isOpen) {
                try {
                    if (!client.hasPendingRequests) {
                        setRuntime(await client.status());
                    }
                } catch {
                    // The read loop owns disconnect reporting.
                }
                timer = setTimeout(poll, 1200);
            }
        };
        timer = setTimeout(poll, 1200);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [busy, connected]);

    useEffect(() => {
        const log = logRef.current;
        if (log) {
            log.scrollTop = log.scrollHeight;
        }
    }, [logs]);

    useEffect(() => () => {
        const client = clientRef.current;
        clientRef.current = undefined;
        if (client) {
            void client.close();
        }
    }, []);

    const runtimeState = runtime?.runtimeState ?? hello?.runtimeState ?? RuntimeState.STOPPED;

    return (
        <main className="app-shell">
            <header className="topbar">
                <div className="brand">
                    <span className="brand-mark">H</span>
                    <div>
                        <h1>HackyLens Code</h1>
                        <p>MicroPython IDE · на базе Pybricks Code</p>
                    </div>
                </div>
                <div className="connection-cluster">
                    <span className={`connection-dot ${connected ? 'online' : ''}`} />
                    <span>{connected ? `${hello?.board ?? 'HackyLens'} · ${hello?.firmwareVersion ?? ''}` : 'не подключено'}</span>
                    <button className={connected ? 'button ghost' : 'button primary'} onClick={connected ? disconnect : connect} disabled={Boolean(busy)}>
                        {connected ? 'Отключить' : 'Подключить USB'}
                    </button>
                </div>
            </header>

            <section className="ide-layout">
                <aside className="sidebar panel">
                    <div className="panel-heading">
                        <div>
                            <span className="eyebrow">USERFS</span>
                            <h2>Скрипты</h2>
                        </div>
                        <button className="icon-button" title="Новый файл" onClick={newFile}>＋</button>
                    </div>
                    <div className="storage-meter">
                        <div><span>{filesystemNames[hello?.filesystemState ?? 0] ?? 'неизвестно'}</span><span>{hello ? `${humanBytes(hello.filesystemUsed)} / ${humanBytes(hello.filesystemTotal)}` : '—'}</span></div>
                        <progress value={hello?.filesystemUsed ?? 0} max={Math.max(1, hello?.filesystemTotal ?? 1)} />
                    </div>
                    <div className="file-list" aria-label="Файлы на устройстве">
                        {files.length === 0 && <p className="empty-state">{mounted ? 'Файлов пока нет' : 'Хранилище недоступно'}</p>}
                        {files.map((file) => (
                            <button key={file.name} className={`file-row ${file.name === fileName ? 'selected' : ''}`} onClick={() => openFile(file)} disabled={Boolean(busy)}>
                                <span className="file-icon">py</span>
                                <span className="file-copy"><strong>{file.name}</strong><small>{humanBytes(file.size)}</small></span>
                                {file.startup && <span className="startup-badge" title="Автозапуск">A</span>}
                            </button>
                        ))}
                    </div>
                    <div className="sidebar-actions">
                        <button className="button ghost" onClick={() => void runBusy('Обновление…', () => refreshFiles())} disabled={!mounted || Boolean(busy)}>Обновить</button>
                        <button className="button danger-text" onClick={format} disabled={!connected || Boolean(busy)}>Форматировать</button>
                    </div>
                </aside>

                <section className="editor-panel panel">
                    <div className="editor-toolbar">
                        <label className="filename-field">
                            <span>Файл</span>
                            <input value={fileName} onChange={(event) => setFileName(event.target.value)} spellCheck={false} disabled={Boolean(busy)} />
                        </label>
                        <div className="source-meta">
                            <span className={runnable ? '' : 'limit-error'}>{sourceBytes} / {hello?.sourceMax ?? 65535} байт VM</span>
                            {dirty && <span className="dirty-pill">не сохранён</span>}
                        </div>
                        <div className="toolbar-actions">
                            <button className="button ghost" onClick={save} disabled={!mounted || Boolean(busy)}>Сохранить</button>
                            <button className="button primary" onClick={run} disabled={!mounted || !runnable || Boolean(busy)}>▶ Запустить</button>
                            <button className="button stop" onClick={stop} disabled={!connected || Boolean(busy) || ![RuntimeState.STARTING, RuntimeState.RUNNING, RuntimeState.STOPPING].includes(runtimeState)}>■ Стоп</button>
                        </div>
                    </div>
                    <MonacoEditor value={source} onChange={setSource} readOnly={Boolean(busy)} />
                </section>

                <aside className="right-column">
                    <section className="runtime-card panel">
                        <div className="panel-heading compact">
                            <div><span className="eyebrow">CORE 1</span><h2>Runtime</h2></div>
                            <span className={`runtime-pill state-${runtimeState}`}>{runtimeNames[runtimeState] ?? runtimeState}</span>
                        </div>
                        <dl className="facts">
                            <div><dt>Run ID</dt><dd>{runtime?.runId ?? '—'}</dd></div>
                            <div><dt>Исходник</dt><dd>{runtime ? humanBytes(runtime.sourceBytes) : '—'}</dd></div>
                            <div><dt>Вывод в очереди</dt><dd>{runtime?.outputPending ?? '—'}</dd></div>
                            <div><dt>Потеряно</dt><dd>{runtime?.outputDropped ?? '—'}</dd></div>
                        </dl>
                        <div className="stacked-actions">
                            <button className="button ghost" onClick={setStartup} disabled={!mounted || Boolean(busy)}>Назначить автозапуск</button>
                            <button className="button ghost" onClick={clearStartup} disabled={!mounted || Boolean(busy) || !files.some((file) => file.startup)}>Очистить автозапуск</button>
                            <button className="button danger-text" onClick={removeFile} disabled={!selected || Boolean(busy)}>Удалить файл</button>
                        </div>
                    </section>
                    <section className="help-card panel">
                        <span className="eyebrow">API V1</span>
                        <h2>Быстрый старт</h2>
                        <code>import hackylens as hl</code>
                        <p>Дисплей, кнопки, LED, UART и I²C — модуль <strong>hackylens</strong>. BACK или «Стоп» безопасно прерывают скрипт.</p>
                    </section>
                </aside>

                <section className="console panel">
                    <div className="console-heading">
                        <div><span className="eyebrow">HMPY EVENTS</span><h2>Вывод</h2></div>
                        <div className="console-actions">
                            {busy && <span className="busy-label">{busy}</span>}
                            {error && <span className="error-label" title={error}>Ошибка: {error}</span>}
                            <button className="button ghost small" onClick={() => setLogs('')}>Очистить</button>
                        </div>
                    </div>
                    <pre ref={logRef}>{logs || ' '}</pre>
                </section>
            </section>
        </main>
    );
};
