// SPDX-License-Identifier: MIT
// Derived from the Monaco integration in Pybricks Code.
// Copyright (c) 2020-2026 The Pybricks Authors.

import * as monaco from 'monaco-editor';
import React, { useEffect, useRef } from 'react';

monaco.editor.defineTheme('hackylens-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
        { token: 'comment', foreground: '738295', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'ffb454' },
        { token: 'string', foreground: '9ece6a' },
        { token: 'number', foreground: 'bb9af7' },
    ],
    colors: {
        'editor.background': '#0b1018',
        'editor.foreground': '#dbe7f3',
        'editor.lineHighlightBackground': '#141d2a',
        'editorCursor.foreground': '#35d4b4',
        'editor.selectionBackground': '#275f6c88',
        'editorLineNumber.foreground': '#526174',
        'editorLineNumber.activeForeground': '#a8c2d9',
    },
});

export interface MonacoEditorProps {
    readonly value: string;
    readonly onChange: (value: string) => void;
    readonly readOnly?: boolean;
}

export const MonacoEditor: React.FC<MonacoEditorProps> = ({ value, onChange, readOnly }) => {
    const hostRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor>();
    const changeRef = useRef(onChange);
    changeRef.current = onChange;

    useEffect(() => {
        const host = hostRef.current;
        if (!host) {
            return undefined;
        }
        const model = monaco.editor.createModel(value, 'python');
        const editor = monaco.editor.create(host, {
            model,
            theme: 'hackylens-dark',
            automaticLayout: false,
            fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
            fontSize: 14,
            lineHeight: 22,
            minimap: { enabled: false },
            padding: { top: 14, bottom: 14 },
            roundedSelection: true,
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            tabSize: 4,
            insertSpaces: true,
            wordWrap: 'on',
            readOnly,
        });
        editorRef.current = editor;
        const subscription = editor.onDidChangeModelContent(() => {
            changeRef.current(editor.getValue());
        });
        const observer = new ResizeObserver(() => editor.layout());
        observer.observe(host);
        return () => {
            observer.disconnect();
            subscription.dispose();
            editor.dispose();
            model.dispose();
            editorRef.current = undefined;
        };
        // The model is intentionally created once; later value changes are handled below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const editor = editorRef.current;
        if (editor && editor.getValue() !== value) {
            const position = editor.getPosition();
            editor.setValue(value);
            if (position) {
                editor.setPosition(position);
            }
        }
    }, [value]);

    useEffect(() => {
        editorRef.current?.updateOptions({ readOnly: Boolean(readOnly) });
    }, [readOnly]);

    return <div className="monaco-host" ref={hostRef} aria-label="Редактор MicroPython" />;
};
