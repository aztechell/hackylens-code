'use strict';

process.env.NODE_ENV = 'production';
process.env.BABEL_ENV = 'production';

const webpack = require('webpack');
const makeConfig = require('../config/webpack.hackylens');
const compiler = webpack(makeConfig({}, { mode: 'production' }));

compiler.run((error, stats) => {
    const finish = (code) => compiler.close(() => {
        process.exitCode = code;
    });
    if (error) {
        console.error(error.stack || error);
        finish(1);
        return;
    }
    if (stats) {
        console.log(stats.toString({ colors: true, preset: 'errors-warnings' }));
    }
    finish(stats?.hasErrors() ? 1 : 0);
});
