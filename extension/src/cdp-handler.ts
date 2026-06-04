/**
 * CDP Handler - Chrome DevTools Protocol 연결 및 스크립트 주입
 * 
 * Based on AAA (Auto Accept Agent) v13 by MunKhin - MIT License
 * Copyright (c) 2025-2026 MunKhin.
 * 
 * Adapted for ReRevolve by rerevolve team.
 * v8.3.9: AAA v13 방식으로 전면 재작성 - 영구 WebSocket + 워크스페이스 필터 제거
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import WebSocket from 'ws';

const BASE_PORT = 9000;
const PORT_RANGE = 3;

interface CDPPage {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl: string;
}

interface CDPConnection {
    ws: WebSocket;
    injected: boolean;
    mode: string | null;
}

export interface CDPStartConfig {
    ide?: string;
    pollInterval?: number;
    isBackgroundMode?: boolean;
    enableAccept?: boolean;
    enableRetry?: boolean;
}

export class CDPHandler {
    private connections = new Map<string, CDPConnection>();
    private msgId = 1;
    isEnabled = false;
    private logger: (msg: string) => void;

    // 내장 auto-accept 스크립트 캐시
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
     * CDP 스크립트 주입 및 시작 (AAA v13 방식: 영구 WebSocket)
     */
    async start(config: CDPStartConfig): Promise<void> {
        this.isEnabled = true;
        
        for (let port = BASE_PORT - PORT_RANGE; port <= BASE_PORT + PORT_RANGE; port++) {
            try {
                const pages = await this._getPages(port);
                if (pages.length > 0) {
                    this.log(`Port ${port}: Found ${pages.length} page(s)`);
                }
                for (const page of pages) {
                    const id = `${port}:${page.id}`;
                    // 연결이 없거나 끊어진 경우 재연결
                    if (!this.connections.has(id)) {
                        await this._connect(id, page.webSocketDebuggerUrl);
                    }
                    await this._inject(id, config);
                }
            } catch { }
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
        this.log('Stopped auto-accept on all pages');
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
                const res = await this._evaluate(id, 'JSON.stringify(window.__autoAcceptGetStats ? window.__autoAcceptGetStats() : {})');
                if (res?.value) {
                    try {
                        const s = JSON.parse(res.value);
                        stats.clicks += s.clicks || 0;
                        stats.blocked += s.blocked || 0;
                        stats.fileEdits += s.fileEdits || 0;
                        stats.terminalCommands += s.terminalCommands || 0;
                    } catch { }
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
                                if (url.startsWith('devtools://') || url.startsWith('chrome-devtools://') || url.includes('devtools/devtools')) return false;
                                // AAA v13과 동일: 워크스페이스 이름 필터 없음
                                // 모든 page/webview에 스크립트 주입
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

    /**
     * 영구 WebSocket 연결 (AAA v13 방식)
     */
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

    /**
     * 스크립트 주입 + 시작 (AAA v13 방식)
     */
    private async _inject(id: string, config: CDPStartConfig): Promise<void> {
        const conn = this.connections.get(id);
        if (!conn) return;

        const mode = `${config.isBackgroundMode ? 'background' : 'simple'}:${config.enableAccept === true ? 'accept' : 'noaccept'}:${config.enableRetry === true ? 'retry' : 'noretry'}`;

        try {
            // Step 1: 스크립트 미주입이면 주입
            if (!conn.injected) {
                const script = this._getAutoAcceptScript();
                this.log(`Injecting script into ${id} (${(script.length / 1024).toFixed(1)}KB)...`);
                await this._evaluate(id, script);
                conn.injected = true;
                this.log(`Script injected into ${id}`);
            }

            // Step 2: 모드 변경 시 재시작
            if (conn.mode !== null && conn.mode !== mode) {
                this.log(`Mode changed from ${conn.mode} to ${mode} on ${id}`);
                await this._evaluate(id, 'if(window.__autoAcceptStop) window.__autoAcceptStop()');
            }

            // Step 3: 시작 (모드 변경 또는 최초)
            if (conn.mode !== mode) {
                const configJson = JSON.stringify({
                    ide: config.ide || 'antigravity',
                    isBackgroundMode: config.isBackgroundMode || false,
                    pollInterval: config.pollInterval || 1000,
                    enableAccept: config.enableAccept === true,
                    enableRetry: config.enableRetry === true,
                    bannedCommands: []
                });
                await this._evaluate(id, `if(window.__autoAcceptStart) window.__autoAcceptStart(${configJson})`);
                conn.mode = mode;
                this.log(`Auto-accept started on ${id} (mode: ${mode})`);
            }
        } catch (e: any) {
            this.log(`Injection failed on ${id}: ${e.message}`);
        }
    }

    /**
     * 영구 WebSocket을 통한 evaluate (AAA v13 방식)
     */
    private async _evaluate(id: string, expression: string): Promise<any> {
        const conn = this.connections.get(id);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
            // 연결이 끊어진 경우 정리
            this.connections.delete(id);
            return null;
        }

        return new Promise((resolve) => {
            const currentId = this.msgId++;
            const timeout = setTimeout(() => resolve(null), 3000);

            const handler = (data: WebSocket.Data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id === currentId) {
                        clearTimeout(timeout);
                        conn.ws.off('message', handler);
                        resolve(msg.result?.result || msg.result);
                    }
                } catch { }
            };

            conn.ws.on('message', handler);
            conn.ws.send(JSON.stringify({
                id: currentId,
                method: 'Runtime.evaluate',
                params: { expression, userGesture: true, awaitPromise: true }
            }));
        });
    }

    private _getAutoAcceptScript(): string {
        if (this._scriptCache) return this._scriptCache;

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
