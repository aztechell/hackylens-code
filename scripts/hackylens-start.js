'use strict';

process.env.NODE_ENV = 'development';
process.env.BABEL_ENV = 'development';

const webpack = require('webpack');
const WebpackDevServer = require('webpack-dev-server');
const makeConfig = require('../config/webpack.hackylens');
const config = makeConfig({}, { mode: 'development' });
const compiler = webpack(config);
const server = new WebpackDevServer(config.devServer, compiler);

server.start().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
