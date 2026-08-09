// SPDX-License-Identifier: MIT

import React, { useMemo, useState } from 'react';

export interface DocEntry {
    readonly signature: string;
    readonly description: string;
}

export interface DocSection {
    readonly id: string;
    readonly label: string;
    readonly kicker: string;
    readonly title: string;
    readonly lead: string;
    readonly entries: readonly DocEntry[];
    readonly notes?: readonly string[];
    readonly example?: string;
}

export const sections: readonly DocSection[] = [
    {
        id: 'start',
        label: 'Начало работы',
        kicker: 'HackyLens MicroPython',
        title: 'Справочник API v1',
        lead: 'Модуль hackylens связывает MicroPython-скрипт с кнопками, дисплеем, подсветкой и внешним разъёмом устройства.',
        entries: [
            {
                signature: 'import hackylens as hl',
                description: 'Импортируйте модуль один раз в начале программы.',
            },
        ],
        notes: [
            'Скрипт выполняется на ядре K210 core 1, интерфейс устройства остаётся отзывчивым.',
            'Стандартный лимит выполнения — 30 секунд, максимальный запрашиваемый лимит — 300 секунд.',
            'Нажатие BACK или команда «Стоп» прерывают программу через KeyboardInterrupt.',
        ],
        example: `import hackylens as hl

hl.display_clear(0x0000)
hl.display_text(8, 8, "MicroPython ready", 0xffff, 0x0000)
hl.display_present()
hl.rgb(0, 64, 0)`,
    },
    {
        id: 'buttons',
        label: 'Кнопки и время',
        kicker: 'Input / time',
        title: 'Кнопки и время',
        lead: 'Чтение кнопок не блокирует программу, а sleep_ms() остаётся доступным для безопасного прерывания.',
        entries: [
            { signature: 'hl.buttons()', description: 'Возвращает текущую битовую маску нажатых кнопок.' },
            { signature: 'hl.button(mask)', description: 'Возвращает True, если нажата хотя бы одна кнопка из mask.' },
            { signature: 'hl.ticks_ms()', description: 'Монотонное время в миллисекундах с момента загрузки.' },
            { signature: 'hl.sleep_ms(duration)', description: 'Кооперативная пауза от 0 до 300000 мс.' },
        ],
        notes: [
            'BUTTON_LEFT = 1, BUTTON_OK = 2, BUTTON_RIGHT = 4, BUTTON_BACK = 8.',
            'Во время sleep_ms() запрос остановки и дедлайн проверяются не реже одного раза в 5 мс.',
        ],
        example: `while not hl.button(hl.BUTTON_BACK):
    if hl.button(hl.BUTTON_OK):
        hl.led(60)
    else:
        hl.led(0)
    hl.sleep_ms(20)`,
    },
    {
        id: 'display',
        label: 'Дисплей',
        kicker: '320 × 240 / RGB565',
        title: 'Дисплей',
        lead: 'Команды формируют ограниченный кадр в памяти. Изменения появляются на панели после display_present().',
        entries: [
            { signature: 'hl.display_clear(color=0)', description: 'Начинает новый кадр и заполняет его цветом RGB565.' },
            { signature: 'hl.display_text(x, y, text, foreground=0xffff, background=0)', description: 'Добавляет строку длиной до 256 байт.' },
            { signature: 'hl.display_rect(x, y, width, height, color, filled=False)', description: 'Добавляет контурный или заполненный прямоугольник.' },
            { signature: 'hl.display_present()', description: 'Атомарно показывает подготовленный кадр.' },
        ],
        notes: [
            'Цвета задаются значениями RGB565 от 0x0000 до 0xffff.',
            'Графика обрезается по правой и нижней границе экрана.',
            'После завершения скрипта прошивка удаляет Python-overlay и восстанавливает свой экран.',
        ],
        example: `hl.display_clear(0x0000)
hl.display_text(8, 8, "Hello", 0xffff, 0x0000)
hl.display_rect(8, 40, 80, 30, 0x07e0, True)
hl.display_present()`,
    },
    {
        id: 'lights',
        label: 'Подсветка и RGB',
        kicker: 'Light output',
        title: 'Подсветка и RGB LED',
        lead: 'Скрипт временно получает управление изменёнными источниками света. Настройки прошивки восстанавливаются после любого завершения.',
        entries: [
            { signature: 'hl.led(brightness)', description: 'Белая подсветка: яркость от 0 до 100, ноль выключает её.' },
            { signature: 'hl.rgb(red, green, blue)', description: 'RGB-индикатор: каждый канал от 0 до 255.' },
        ],
        example: `hl.led(60)
hl.rgb(0, 64, 16)
hl.sleep_ms(500)
hl.led(0)
hl.rgb(0, 0, 0)`,
    },
    {
        id: 'uart',
        label: 'Внешний UART',
        kicker: 'IO34 / IO35',
        title: 'Внешний UART',
        lead: 'UART использует внешний разъём HUSKYLENS. При первом вызове скрипт временно забирает разъём у штатного external-link сервиса.',
        entries: [
            { signature: 'hl.uart_init(baud=115200)', description: 'Настраивает UART со скоростью от 1200 до 2000000 бод.' },
            { signature: 'hl.uart_write(data)', description: 'Передаёт str или bytes и возвращает число отправленных байт.' },
            { signature: 'hl.uart_read(size=64)', description: 'Неблокирующе читает до 256 доступных байт.' },
        ],
        notes: [
            'Большая запись автоматически разбивается на сервисные блоки по 256 байт.',
            'Если данных нет, uart_read() возвращает b"".',
        ],
        example: `hl.uart_init(115200)
hl.uart_write("ping\\n")
reply = hl.uart_read(64)
print(reply)`,
    },
    {
        id: 'i2c',
        label: 'Внешний I²C',
        kicker: '100 kHz / 7-bit',
        title: 'Внешний I²C',
        lead: 'I²C использует тот же внешний разъём и работает с семибитными адресами устройств.',
        entries: [
            { signature: 'hl.i2c_write(address, data)', description: 'Записывает до 256 байт по адресу от 1 до 127.' },
            { signature: 'hl.i2c_read(address, size, prefix=b"")', description: 'При необходимости пишет prefix, затем читает до 256 байт.' },
        ],
        notes: [
            'Аппаратный дедлайн одной транзакции — 100 мс.',
            'NACK или ошибка шины вызывают OSError, превышение сервисного дедлайна — RuntimeError.',
        ],
        example: `address = 0x40
hl.i2c_write(address, b"\\x01\\x00")
value = hl.i2c_read(address, 2, b"\\x02")
print(value)`,
    },
    {
        id: 'cleanup',
        label: 'Стоп и cleanup',
        kicker: 'Runtime contract',
        title: 'Остановка и очистка',
        lead: 'Остановка доставляется как KeyboardInterrupt. Запрос остаётся активным, даже если программа кратковременно перехватила исключение.',
        entries: [
            { signature: 'KeyboardInterrupt', description: 'Возникает при BACK, команде «Стоп» или достижении дедлайна.' },
            { signature: 'automatic cleanup', description: 'Освобождает дисплей, свет и внешний разъём после normal, stop, timeout или exception.' },
        ],
        notes: [
            'Все аппаратные вызовы имеют ограниченное время выполнения.',
            'Если core 1 не остановился штатно, прошивка использует WDT1 как аварийный механизм восстановления.',
            'Camera, KPU, SD/files и vision-result не входят в API v1.',
        ],
        example: `try:
    while True:
        print(hl.ticks_ms())
        hl.sleep_ms(100)
except KeyboardInterrupt:
    print("stopped")`,
    },
];

export interface HackyLensDocsProps {
    readonly onClose: () => void;
}

export function filterDocSections(query: string): readonly DocSection[] {
    const normalizedQuery = query.trim().toLocaleLowerCase('ru');
    if (!normalizedQuery) {
        return sections;
    }
    return sections
        .map((section) => ({
            ...section,
            entries: section.entries.filter((entry) =>
                `${entry.signature} ${entry.description}`.toLocaleLowerCase('ru').includes(normalizedQuery)),
        }))
        .filter((section) =>
            `${section.label} ${section.title} ${section.lead}`.toLocaleLowerCase('ru').includes(normalizedQuery) ||
            section.entries.length > 0);
}

export const HackyLensDocs: React.FC<HackyLensDocsProps> = ({ onClose }) => {
    const [activeId, setActiveId] = useState(sections[0].id);
    const [query, setQuery] = useState('');
    const normalizedQuery = query.trim().toLocaleLowerCase('ru');

    const visibleSections = useMemo(() => {
        if (!normalizedQuery) {
            return sections.filter((section) => section.id === activeId);
        }
        return filterDocSections(normalizedQuery);
    }, [activeId, normalizedQuery]);

    return (
        <aside className="docs-panel" aria-label="Документация HackyLens">
            <header className="docs-toolbar">
                <div>
                    <span className="eyebrow">HACKYLENS REFERENCE</span>
                    <h2>Документация</h2>
                </div>
                <button className="docs-close" type="button" onClick={onClose} aria-label="Закрыть документацию">×</button>
            </header>
            <div className="docs-search">
                <label htmlFor="docs-query">Поиск по API</label>
                <input
                    id="docs-query"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="display, UART, кнопки…"
                    autoComplete="off"
                />
            </div>
            <div className="docs-layout">
                <nav className="docs-nav" aria-label="Разделы документации">
                    {sections.map((section) => (
                        <button
                            key={section.id}
                            type="button"
                            className={section.id === activeId && !normalizedQuery ? 'active' : ''}
                            onClick={() => {
                                setActiveId(section.id);
                                setQuery('');
                            }}
                        >
                            <span>{section.label}</span>
                            <span aria-hidden="true">›</span>
                        </button>
                    ))}
                    <small>MicroPython API v1</small>
                </nav>
                <article className="docs-content">
                    {normalizedQuery && (
                        <p className="docs-results">Результаты поиска: <strong>{query.trim()}</strong></p>
                    )}
                    {visibleSections.length === 0 && (
                        <div className="docs-empty">
                            <h1>Ничего не найдено</h1>
                            <p>Попробуйте имя функции, например <code>display_present</code> или <code>uart_read</code>.</p>
                        </div>
                    )}
                    {visibleSections.map((section) => (
                        <section className="docs-section" key={section.id}>
                            <span className="docs-kicker">{section.kicker}</span>
                            <h1>{section.title}</h1>
                            <p className="docs-lead">{section.lead}</p>
                            <div className="docs-reference">
                                {section.entries.map((entry) => (
                                    <div className="docs-entry" key={entry.signature}>
                                        <code>{entry.signature}</code>
                                        <p>{entry.description}</p>
                                    </div>
                                ))}
                            </div>
                            {section.notes && section.notes.length > 0 && (
                                <ul className="docs-notes">
                                    {section.notes.map((note) => <li key={note}>{note}</li>)}
                                </ul>
                            )}
                            {section.example && (
                                <div className="docs-example">
                                    <div><span>Пример</span><span>Python</span></div>
                                    <pre><code>{section.example}</code></pre>
                                </div>
                            )}
                        </section>
                    ))}
                </article>
            </div>
        </aside>
    );
};
