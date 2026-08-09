'use strict';

// Focused HackyLens build that reuses the pinned Pybricks Code toolchain while
// excluding the original LEGO firmware, Bluetooth, Pyodide and service-worker
// backends from the bundle.

const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (_environment, argv = {}) => {
    const mode = argv.mode === 'development' ? 'development' : 'production';
    const production = mode === 'production';
    process.env.NODE_ENV = mode;
    process.env.BABEL_ENV = mode;

    const root = path.resolve(__dirname, '..');
    const source = path.join(root, 'src');

    return {
        mode,
        bail: production,
        devtool: production ? false : 'cheap-module-source-map',
        entry: path.join(source, 'index.tsx'),
        output: {
            path: path.join(root, 'build'),
            filename: production ? 'static/js/[name].[contenthash:8].js' : 'static/js/bundle.js',
            chunkFilename: production ? 'static/js/[name].[contenthash:8].chunk.js' : 'static/js/[name].chunk.js',
            assetModuleFilename: 'static/media/[name].[hash:8][ext]',
            publicPath: production ? './' : '/',
            clean: true,
            globalObject: 'self',
        },
        resolve: {
            extensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
        },
        module: {
            rules: [
                {
                    test: /\.(ts|tsx|js|jsx)$/,
                    include: source,
                    loader: require.resolve('babel-loader'),
                    options: {
                        babelrc: false,
                        configFile: false,
                        presets: [
                            [require.resolve('babel-preset-react-app'), { runtime: 'automatic' }],
                        ],
                        cacheDirectory: true,
                        cacheCompression: false,
                    },
                },
                {
                    test: /\.css$/,
                    use: [require.resolve('style-loader'), require.resolve('css-loader')],
                },
                {
                    test: /\.s[ac]ss$/i,
                    use: [
                        require.resolve('style-loader'),
                        require.resolve('css-loader'),
                        require.resolve('sass-loader'),
                    ],
                },
                {
                    test: /\.(png|jpe?g|gif|svg|woff2?|ttf|eot)$/i,
                    type: 'asset',
                    parser: { dataUrlCondition: { maxSize: 8192 } },
                },
            ],
        },
        plugins: [
            new webpack.DefinePlugin({
                'process.env.NODE_ENV': JSON.stringify(mode),
            }),
            new HtmlWebpackPlugin({
                template: path.join(root, 'public', 'index.html'),
                minify: production,
            }),
            new CopyWebpackPlugin({
                patterns: [
                    { from: path.join(root, 'LICENSE'), to: 'LICENSE', toType: 'file' },
                    { from: path.join(root, 'HACKYLENS_NOTICE.md'), to: 'HACKYLENS_NOTICE.md' },
                    { from: path.join(root, 'HACKYLENS_UPSTREAM.json'), to: 'HACKYLENS_UPSTREAM.json' },
                    { from: path.join(root, 'README.HACKYLENS.md'), to: 'README.md' },
                ],
            }),
            new MonacoWebpackPlugin({
                languages: ['python'],
                filename: 'static/js/[name].[contenthash:8].worker.js',
            }),
        ],
        optimization: {
            minimize: production,
            runtimeChunk: 'single',
            splitChunks: { chunks: 'all' },
        },
        performance: { hints: false },
        stats: 'errors-warnings',
        devServer: {
            host: '127.0.0.1',
            port: 4173,
            hot: true,
            historyApiFallback: true,
            static: { directory: path.join(root, 'public') },
            client: { overlay: true },
        },
    };
};
