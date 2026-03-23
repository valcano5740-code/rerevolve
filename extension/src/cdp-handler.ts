/**
 * CDP Handler - Chrome DevTools Protocol 연결 및 스크립트 주입
 * 
 * Based on AAA (Auto Accept Agent) by MunKhin - MIT License
 * Copyright (c) 2025-2026 MunKhin.
 * 
 * Adapted for ReRevolve by rerevolve team.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';

const BASE_PORT = 9000;
const PORT_RANGE = 3;

interface CDPConnection {
    ws: WebSocket;
    injected: boolean;
    mode: string | null;
}

interface CDPPage {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
}

export class CDPHandler {
    private connections: Map<string, CDPConnection> = new Map();
    private msgId = 1;
    isEnabled = false;
    private logger: (msg: string) => void;

    // 내장 auto-accept 스크립트 (빌드 시 함께 포함)
    private _scriptCache: string | null = null;

    constructor(logger: (msg: string) => void = console.log) {
        this.logger = logger;
    }

    private log(msg: string): void {
        this.logger(`[CDP] ${msg}`);
    }

    /**
     * CDP 사용 가능 여부 확인
     */
    async isCDPAvailable(): Promise<boolean> {
        for (let port = BASE_PORT - PORT_RANGE; port <= BASE_PORT + PORT_RANGE; port++) {
            try {
                const pages = await this._getPages(port);
                if (pages.length > 0) return true;
            } catch { }
        }
        return false;
    }

    /**
     * CDP 연결 시작 + 스크립트 주입
     */
    async start(config: { ide?: string; pollInterval?: number }): Promise<void> {
        this.isEnabled = true;
        this.log(`Scanning ports ${BASE_PORT - PORT_RANGE} to ${BASE_PORT + PORT_RANGE}...`);

        let connected = false;
        for (let port = BASE_PORT - PORT_RANGE; port <= BASE_PORT + PORT_RANGE; port++) {
            try {
                const pages = await this._getPages(port);
                if (pages.length > 0) {
                    this.log(`Port ${port}: Found ${pages.length} page(s)`);
                    connected = true;
                }
                for (const page of pages) {
                    const id = `${port}:${page.id}`;
                    if (!this.connections.has(id)) {
                        await this._connect(id, page.webSocketDebuggerUrl);
                    }
                    await this._inject(id, config);
                }
            } catch { }
        }

        if (!connected) {
            this.log('No CDP pages found. CDP auto-accept disabled.');
        }
    }

    /**
     * CDP 연결 중지
     */
    async stop(): Promise<void> {
        this.isEnabled = false;
        for (const [id, conn] of this.connections) {
            try {
                await this._evaluate(id, 'if(window.__autoAcceptStop) window.__autoAcceptStop()');
                conn.mode = null;
                conn.ws.close();
            } catch { }
        }
        this.connections.clear();
        this.log('Stopped all connections');
    }

    /**
     * 연결 수 조회
     */
    getConnectionCount(): number {
        return this.connections.size;
    }

    /**
     * 클릭 통계 조회
     */
    async getStats(): Promise<{ clicks: number; blocked: number; fileEdits: number; terminalCommands: number }> {
        const stats = { clicks: 0, blocked: 0, fileEdits: 0, terminalCommands: 0 };
        for (const [id] of this.connections) {
            try {
                const res = await this._evaluate(id,
                    'JSON.stringify(window.__autoAcceptGetStats ? window.__autoAcceptGetStats() : {})'
                );
                if (res?.result?.value) {
                    const s = JSON.parse(res.result.value);
                    stats.clicks += s.clicks || 0;
                    stats.blocked += s.blocked || 0;
                    stats.fileEdits += s.fileEdits || 0;
                    stats.terminalCommands += s.terminalCommands || 0;
                }
            } catch { }
        }
        return stats;
    }

    // ========== Private Methods ==========

    private async _getPages(port: number): Promise<CDPPage[]> {
        return new Promise((resolve) => {
            const req = http.get(
                { hostname: '127.0.0.1', port, path: '/json/list', timeout: 500 },
                (res) => {
                    let body = '';
                    res.on('data', (chunk: Buffer) => body += chunk);
                    res.on('end', () => {
                        try {
                            const pages: CDPPage[] = JSON.parse(body);
                            const filtered = pages.filter(p => {
                                if (!p.webSocketDebuggerUrl) return false;
                                if (p.type !== 'page' && p.type !== 'webview') return false;
                                const url = (p.url || '').toLowerCase();
                                if (url.startsWith('devtools://') || url.includes('devtools/devtools')) return false;
                                return true;
                            });
                            resolve(filtered);
                        } catch { resolve([]); }
                    });
                }
            );
            req.on('error', () => resolve([]));
            req.on('timeout', () => { req.destroy(); resolve([]); });
        });
    }

    private async _connect(id: string, url: string): Promise<boolean> {
        return new Promise((resolve) => {
            const ws = new WebSocket(url);
            ws.on('open', () => {
                this.connections.set(id, { ws, injected: false, mode: null });
                this.log(`Connected to page ${id}`);
                resolve(true);
            });
            ws.on('error', () => resolve(false));
            ws.on('close', () => {
                this.connections.delete(id);
                this.log(`Disconnected from page ${id}`);
            });
        });
    }

    private async _inject(id: string, config: { ide?: string; pollInterval?: number }): Promise<void> {
        const conn = this.connections.get(id);
        if (!conn) return;

        const mode = 'simple'; // Background 모드 불필요

        try {
            // Step 1: 스크립트 주입
            if (!conn.injected) {
                const script = this._getAutoAcceptScript();
                this.log(`Injecting script into ${id} (${(script.length / 1024).toFixed(1)}KB)...`);
                await this._evaluate(id, script);
                conn.injected = true;
                this.log(`Script injected into ${id}`);
            }

            // Step 2: 모드 시작
            if (conn.mode !== mode) {
                if (conn.mode !== null) {
                    await this._evaluate(id, 'if(window.__autoAcceptStop) window.__autoAcceptStop()');
                }

                const configJson = JSON.stringify({
                    ide: config.ide || 'antigravity',
                    isBackgroundMode: false,
                    pollInterval: config.pollInterval || 1000,
                    bannedCommands: []
                });
                await this._evaluate(id, `if(window.__autoAcceptStart) window.__autoAcceptStart(${configJson})`);
                conn.mode = mode;
                this.log(`Auto-accept started on ${id}`);
            }
        } catch (e: any) {
            this.log(`Injection failed for ${id}: ${e.message}`);
        }
    }

    private async _evaluate(id: string, expression: string): Promise<any> {
        const conn = this.connections.get(id);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;

        return new Promise((resolve, reject) => {
            const currentId = this.msgId++;
            const timeout = setTimeout(() => reject(new Error('CDP Timeout')), 3000);

            const onMessage = (data: WebSocket.Data) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === currentId) {
                    conn.ws.off('message', onMessage);
                    clearTimeout(timeout);
                    resolve(msg.result);
                }
            };

            conn.ws.on('message', onMessage);
            conn.ws.send(JSON.stringify({
                id: currentId,
                method: 'Runtime.evaluate',
                params: { expression, userGesture: true, awaitPromise: true }
            }));
        });
    }

    private _getAutoAcceptScript(): string {
        if (this._scriptCache) return this._scriptCache;

        // 빌드된 위치에서 cdp-auto-accept.js 로드
        const candidates = [
            path.join(__dirname, 'cdp-auto-accept.js'),
            path.join(__dirname, '..', 'src', 'cdp-auto-accept.js'),
            path.join(__dirname, '..', 'dist', 'cdp-auto-accept.js'),
        ];

        for (const p of candidates) {
            if (fs.existsSync(p)) {
                this._scriptCache = fs.readFileSync(p, 'utf8');
                return this._scriptCache;
            }
        }

        throw new Error(`cdp-auto-accept.js not found. Searched: ${candidates.join(', ')}`);
    }
}
