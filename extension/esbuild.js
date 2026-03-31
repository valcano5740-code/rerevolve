const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');

async function main() {
    // sql.js의 wasm 파일을 dist로 복사
    const sqlJsWasmSrc = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    const distDir = path.join(__dirname, 'dist');
    if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
    if (fs.existsSync(sqlJsWasmSrc)) {
        fs.copyFileSync(sqlJsWasmSrc, path.join(distDir, 'sql-wasm.wasm'));
        console.log('Copied sql-wasm.wasm to dist/');
    }

    // cdp-auto-accept.js를 dist로 복사
    const cdpScript = path.join(__dirname, 'src', 'cdp-auto-accept.js');
    if (fs.existsSync(cdpScript)) {
        fs.copyFileSync(cdpScript, path.join(distDir, 'cdp-auto-accept.js'));
        console.log('Copied cdp-auto-accept.js to dist/');
    }

    // .credentials.json을 dist 상위(extension root)에 복사는 불필요 — 이미 root에 있음

    await esbuild.build({
        entryPoints: ['./src/extension.ts'],
        bundle: true,
        outfile: './dist/extension.js',
        external: [
            'vscode',    // VS Code API는 런타임 제공
        ],
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        sourcemap: !production,
        minify: production,
        // sql.js는 wasm을 로드하므로 특별 처리
        // sql.js의 wasm 로딩 경로를 올바르게 해결하기 위한 플러그인
        plugins: [{
            name: 'sql-js-wasm',
            setup(build) {
                // sql.js가 wasm 파일을 찾을 수 있도록 locateFile 설정을 주입
                build.onResolve({ filter: /sql\.js$/ }, args => {
                    return { path: require.resolve('sql.js'), external: false };
                });
            }
        }],
        loader: {
            '.wasm': 'file',
        },
    });

    console.log('Build complete!');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
