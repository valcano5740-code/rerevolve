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

export class CDPHandler {
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
     * CDP 스크립트 주입 및 갱신 (주기적 호출용)
     */
    async start(config: { ide?: string; pollInterval?: number }): Promise<void> {
        this.isEnabled = true;
        
        let connected = false;
        for (let port = BASE_PORT - PORT_RANGE; port <= BASE_PORT + PORT_RANGE; port++) {
            try {
                const pages = await this._getPages(port);
                if (pages.length > 0) connected = true;
                
                for (const page of pages) {
                    await this._injectOne(page.webSocketDebuggerUrl, config);
                }
            } catch { }
        }
    }

    /**
     * CDP 연결 중지 (모든 페이지 대상 일회성 명령 전송)
     */
    async stop(): Promise<void> {
        this.isEnabled = false;
        
        for (let port = BASE_PORT - PORT_RANGE; port <= BASE_PORT + PORT_RANGE; port++) {
            try {
                const pages = await this._getPages(port);
                for (const page of pages) {
                    await this._evaluateStateless(page.webSocketDebuggerUrl, 'if(window.__autoAcceptStop) window.__autoAcceptStop()');
                }
            } catch { }
        }
        this.log('Stopped auto-accept on all existing pages');
    }

    /**
     * 연결 수 조회 (Stateless이므로 항상 0 반환, UI 표기용 유지)
     */
    getConnectionCount(): number {
        return 0;
    }

    /**
     * 클릭 통계 조회
     */
    async getStats(): Promise<{ clicks: number; blocked: number; fileEdits: number; terminalCommands: number }> {
        const stats = { clicks: 0, blocked: 0, fileEdits: 0, terminalCommands: 0 };
        for (let port = BASE_PORT - PORT_RANGE; port <= BASE_PORT + PORT_RANGE; port++) {
            try {
                const pages = await this._getPages(port);
                for (const page of pages) {
                    const res = await this._evaluateStateless(page.webSocketDebuggerUrl, 'JSON.stringify(window.__autoAcceptGetStats ? window.__autoAcceptGetStats() : {})');
                    if (res?.result?.value) {
                        try {
                            const s = JSON.parse(res.result.value);
                            stats.clicks += s.clicks || 0;
                            stats.blocked += s.blocked || 0;
                            stats.fileEdits += s.fileEdits || 0;
                            stats.terminalCommands += s.terminalCommands || 0;
                        } catch { }
                    }
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
                                
                                // 다중 창 환경(단일 프로세스 공유) 대응: 자신의 창(워크스페이스)에 해당하는 페이지만 연결
                                // Antigravity 페이지 title은 대개 워크스페이스 이름을 포함함
                                const workspaceName = vscode.workspace.name;
                                if (workspaceName && p.title) {
                                    if (!p.title.includes(workspaceName)) {
                                        return false;
                                    }
                                }
                                
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

    private async _evaluateStateless(url: string, expression: string): Promise<any> {
        return new Promise((resolve) => {
            const ws = new WebSocket(url);
            let isResolved = false;

            const cleanup = () => {
                if (!isResolved) {
                    isResolved = true;
                    try { ws.close(); } catch { }
                    resolve(null);
                }
            };

            const timeout = setTimeout(cleanup, 2000);

            ws.on('open', () => {
                const currentId = this.msgId++;
                ws.on('message', (data: WebSocket.Data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.id === currentId) {
                            clearTimeout(timeout);
                            if (!isResolved) {
                                isResolved = true;
                                try { ws.close(); } catch { }
                                resolve(msg.result);
                            }
                        }
                    } catch { }
                });

                ws.send(JSON.stringify({
                    id: currentId,
                    method: 'Runtime.evaluate',
                    params: { expression, userGesture: true, awaitPromise: true }
                }));
            });

            ws.on('error', cleanup);
        });
    }

    private async _injectOne(url: string, config: { ide?: string; pollInterval?: number }): Promise<void> {
        try {
            // Step 1: 스크립트가 이미 있는지 확인, 없으면 주입
            const checkRes = await this._evaluateStateless(url, 'typeof window.__autoAcceptStart');
            if (checkRes?.value === 'undefined') {
                const script = this._getAutoAcceptScript();
                await this._evaluateStateless(url, script);
                this.log(`Script injected statelessly`);
            }

            // Step 2: check if already running (AAA uses __autoAcceptFreeState)
            const checkRun = await this._evaluateStateless(url, 'window.__autoAcceptFreeState && window.__autoAcceptFreeState.isRunning');
            if (checkRun?.value !== true) {
                // Auto-Accept 시작 명령 전송
                const configJson = JSON.stringify({
                    ide: config.ide || 'antigravity',
                    isBackgroundMode: false,
                    pollInterval: config.pollInterval || 1000,
                    bannedCommands: []
                });
                await this._evaluateStateless(url, `if(window.__autoAcceptStart) window.__autoAcceptStart(${configJson})`);
                this.log(`Auto-accept started via stateless CDP`);
            }
        } catch (e: any) {
            this.log(`Stateless injection failed: ${e.message}`);
        }
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
