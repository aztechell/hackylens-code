'use strict';

module.exports = {
    rootDir: '..',
    testEnvironment: 'node',
    testMatch: ['<rootDir>/src/hackylens/**/*.test.ts'],
    modulePathIgnorePatterns: ['<rootDir>/migration/'],
    transform: {
        '^.+\\.(ts|tsx|js|jsx)$': '<rootDir>/config/jest/babelTransform.js',
    },
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
    resetMocks: true,
};
