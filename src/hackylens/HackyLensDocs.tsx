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
        lead: 'IDE подключается к HUSKYLENS SEN0305 и Sipeed Maix Cube с прошивкой HackyLens. Модуль hackylens даёт скрипту доступ к кнопкам, дисплею, подсветке и внешнему разъёму платы.',
        entries: [
            {
                signature: 'import hackylens as hl',
                description: 'Импортируйте модуль один раз в начале программы.',
            },
        ],
        notes: [
            'Подключите плату по USB и выберите её порт. Maix Cube может показывать два одинаковых порта. Если один не отвечает, попробуйте другой.',
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
            'На Maix Cube кнопка POW служит кнопкой BACK.',
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
        kicker: 'RGB565',
        title: 'Дисплей',
        lead: 'Команды формируют ограниченный кадр в памяти. Изменения появляются на панели после display_present().',
        entries: [
            { signature: 'hl.display_clear(color=0)', description: 'Начинает новый кадр и заполняет его цветом RGB565.' },
            { signature: 'hl.display_text(x, y, text, foreground=0xffff, background=0)', description: 'Добавляет строку длиной до 256 байт.' },
            { signature: 'hl.display_rect(x, y, width, height, color, filled=False)', description: 'Добавляет контурный или заполненный прямоугольник.' },
            { signature: 'hl.display_present()', description: 'Атомарно показывает подготовленный кадр.' },
        ],
        notes: [
            'Разрешение дисплея: 320 × 240 на SEN0305 и 240 × 240 на Maix Cube.',
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
        kicker: 'Внешний разъём',
        title: 'Внешний UART',
        lead: 'UART использует внешний разъём платы. При первом вызове скрипт временно получает управление разъёмом у штатного сервиса.',
        entries: [
            { signature: 'hl.uart_init(baud=115200)', description: 'Настраивает UART со скоростью от 1200 до 2000000 бод.' },
            { signature: 'hl.uart_write(data)', description: 'Передаёт str или bytes и возвращает число отправленных байт.' },
            { signature: 'hl.uart_read(size=64)', description: 'Неблокирующе читает до 256 доступных байт.' },
        ],
        notes: [
            'SEN0305 использует IO34 (RX) и IO35 (TX). Maix Cube использует IO24 (RX) и IO25 (TX) на Grove.',
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
            'SEN0305 использует IO34 (SCL) и IO35 (SDA). Maix Cube использует IO24 (SCL) и IO25 (SDA) на Grove.',
            'Аппаратный дедлайн одной транзакции — 100 мс.',
            'NACK или ошибка шины вызывают OSError, превышение сервисного дедлайна — RuntimeError.',
        ],
        example: `address = 0x40
hl.i2c_write(address, b"\\x01\\x00")
value = hl.i2c_read(address, 2, b"\\x02")
print(value)`,
    },
    {
        id: 'camera',
        label: 'Камера и цвет',
        kicker: 'SEN0305 / Maix Cube',
        title: 'Камера и трекер цвета',
        lead: 'Кадр остаётся в буфере камеры. Скрипт получает его номер и размеры, ищет цветовую область и выводит кадр с рамкой на экран платы.',
        entries: [
            { signature: 'hl.camera_open() / hl.camera_close()', description: 'Открывает камеру для скрипта и освобождает её после работы.' },
            { signature: 'hl.camera_frame()', description: 'Возвращает (lease, width, height, sequence) или None, пока кадр не готов.' },
            { signature: 'hl.camera_find_color(lease, threshold, roi, min_pixels)', description: 'Возвращает (x, y, width, height, pixels) для самой крупной связной области или None. ROI можно задать прямоугольником или передать None для всего кадра.' },
            { signature: 'hl.camera_present(lease, box)', description: 'Показывает кадр на экране платы. Передайте (x, y, width, height) для рамки или None.' },
            { signature: 'hl.camera_release(lease)', description: 'Возвращает буфер камере. Освободите кадр перед запросом следующего.' },
            { signature: 'hl.camera_model_open(source, package)', description: 'Загружает FACE DETECT или OBJECT DETECT с microSD. Укажите hl.VISION_FACE или hl.VISION_OBJECT_DETECT. Имя пакета можно опустить для штатной модели.' },
            { signature: 'hl.camera_detect(lease)', description: 'Запускает детектор на выбранном кадре и возвращает словарь с координатами в ориентации экрана.' },
            { signature: 'hl.camera_scan(lease, source)', description: 'Декодирует hl.VISION_QR или hl.VISION_APRILTAG на выбранном кадре. Возвращает рамки, содержимое QR в qr_payload или номера меток в items.' },
            { signature: 'hl.camera_save(lease, name)', description: 'Сохраняет кадр как BMP в /PYDATA на microSD. Передайте имя 8.3, например FRAME.BMP.' },
            { signature: 'hl.sd_write(name, data)', description: 'Создаёт новый файл в /PYDATA из bytes или bytearray и возвращает число записанных байтов. Имя должно быть в формате 8.3.' },
            { signature: 'hl.camera_model_close()', description: 'Освобождает KPU и модель. Закрытие камеры также освобождает модель.' },
        ],
        notes: [
            'На плате откройте главное меню или MICRO-PYTHON. В IDE откройте «Камера», сделайте снимок и выделите участок нужного цвета. Скопируйте порог из шести чисел в скрипт.',
            'Координаты идут от левого верхнего угла кадра после поворота под экран платы.',
        ],
        example: `threshold = (20, 31, 0, 18, 0, 10)
hl.camera_open()
try:
    while not hl.button(hl.BUTTON_BACK):
        frame = hl.camera_frame()
        if frame is None:
            hl.sleep_ms(5)
            continue
        lease = frame[0]
        try:
            blob = hl.camera_find_color(lease, threshold, None, 24)
            box = (blob[0], blob[1], blob[2], blob[3]) if blob else None
            hl.camera_present(lease, box)
        finally:
            hl.camera_release(lease)
finally:
    hl.camera_close()`,
    },
    {
        id: 'vision',
        label: 'Результаты распознавания',
        kicker: 'C / MicroPython',
        title: 'Результаты распознавания',
        lead: 'Python читает последний результат активного FACE DETECT, QR-CAMERA, APRILTAG, OBJECT DETECT или FACE RECOG из того же сервиса, что и C.',
        entries: [
            { signature: 'hl.vision_results()', description: 'Возвращает словарь с frame_id, source, width, height, items и qr_payload.' },
            { signature: 'hl.VISION_NONE, hl.VISION_FACE, hl.VISION_QR, hl.VISION_APRILTAG, hl.VISION_OBJECT_DETECT', description: 'Значения source. VISION_USER зарезервирован для пользовательских алгоритмов.' },
            { signature: 'hl.VISION_FACE_RECOGNITION', description: 'Источник FACE RECOG. ID 1–10 соответствует сохранённому лицу, ID 0 означает UNKNOWN.' },
            { signature: 'hl.VISION_BLOCK / hl.VISION_ARROW', description: 'Вид результата. Пары координат задают углы блока или концы стрелки в исходном кадре.' },
        ],
        notes: [
            'Каждый элемент items — кортеж (kind, flags, id, x0, y0, x1, y1, confidence).',
            'QR возвращает один блок и до 383 байт в qr_payload. Остальные источники возвращают пустые байты.',
            'Оставьте приложение распознавания открытым на плате. Для QR и APRILTAG запускайте короткий скрипт после появления результата, чтобы освободить общее ядро для следующего сканирования.',
        ],
        example: `result = hl.vision_results()
for kind, flags, item_id, x0, y0, x1, y1, confidence in result["items"]:
    print(item_id, x0, y0, x1, y1)
if result["source"] == hl.VISION_QR and result["items"]:
    print(result["qr_payload"])`,
    },
    {
        id: 'cleanup',
        label: 'Стоп и cleanup',
        kicker: 'Runtime contract',
        title: 'Остановка и очистка',
        lead: 'Остановка доставляется как KeyboardInterrupt. Запрос остаётся активным, даже если программа кратковременно перехватила исключение.',
        entries: [
            { signature: 'KeyboardInterrupt', description: 'Возникает при BACK, команде «Стоп» или достижении дедлайна.' },
            { signature: 'automatic cleanup', description: 'Освобождает камеру, дисплей, свет и внешний разъём при завершении, остановке, дедлайне или ошибке.' },
        ],
        notes: [
            'Все аппаратные вызовы имеют ограниченное время выполнения.',
            'Если core 1 не остановился штатно, прошивка использует WDT1 как аварийный механизм восстановления.',
            'Пиксели кадра, KPU и файлы SD пока недоступны напрямую из Python.',
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
