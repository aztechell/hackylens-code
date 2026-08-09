// SPDX-License-Identifier: MIT
// HackyLens Code is derived from Pybricks Code at the pinned revision recorded
// in HACKYLENS_UPSTREAM.json. See LICENSE and HACKYLENS_NOTICE.md.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { HackyLensApp } from './hackylens/HackyLensApp';

const root = document.getElementById('root');
if (!root) {
    throw new Error('Missing #root element');
}

createRoot(root).render(
    <React.StrictMode>
        <HackyLensApp />
    </React.StrictMode>,
);
