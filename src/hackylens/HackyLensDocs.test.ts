// SPDX-License-Identifier: MIT

import { filterDocSections, sections } from './HackyLensDocs';

describe('HackyLens documentation', () => {
    it('contains the complete v1 navigation', () => {
        expect(sections.map((section) => section.id)).toEqual([
            'start', 'buttons', 'display', 'lights', 'uart', 'i2c', 'vision', 'cleanup',
        ]);
    });

    it('finds API signatures across sections', () => {
        const result = filterDocSections('uart_read');

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('uart');
        expect(result[0].entries.map((entry) => entry.signature)).toEqual(['hl.uart_read(size=64)']);
    });

    it('returns no sections for an unknown API name', () => {
        expect(filterDocSections('not_a_hackylens_function')).toEqual([]);
    });
});
