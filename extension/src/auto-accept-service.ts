/**
 * Auto-Accept Service - CDP 기반 구현 + VS Code 명령어 직접 호출
 * AAA(Auto Accept Agent) 방식 참고
 * v3.1: CDP WebSocket + Antigravity 내부 명령어 하이브리드 방식
 */

import * as vscode from 'vscode';
import * as http from 'http';
import WebSocket from 'ws';

// CDP 포트 설정
const BASE_PORT = 9000;
const PORT_RANGE = 10;

// 위험 명령어 패턴
const DANGEROUS_PATTERNS = [
    /rm\s+-rf\s+[\/~\*]/i,
    /rm\s+-fr\s+[\/~\*]/i,
    /del\s+\/[sfq]/i,
    /format\s+[a-z]:/i,
    /mkfs/i,
    /dd\s+if=/i,
    /:\s*\(\)\s*\{\s*:\s*\|\s*:/,
    />\s*\/dev\/sda/i,
    /chmod\s+-R\s+777\s+\//i,
];

// Antigravity 내부 Accept 명령어 (VS Code API로 직접 호출)
// Ricco6/always-accept-antigravity에서 참조
const ANTIGRAVITY_ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',       // 에이전트 스텝 승인
    'antigravity.terminalCommand.accept',      // 터미널 명령 승인
    'antigravity.prioritized.agentAcceptFocusedHunk', // Diff 허unk 승인
    'antigravity.command.accept',               // 일반 명령 승인
    'antigravity.terminalCommand.run'           // 터미널 명령 실행
];

// Accept 버튼 텍스트 패턴 (CDP DOM 클릭 fallback용)
const ACCEPT_PATTERNS = ['accept all', 'accept', 'run', 'retry', 'apply', 'execute', 'confirm', 'allow once', 'allow'];
const REJECT_PATTERNS = ['skip', 'reject', 'cancel', 'close', 'refine', 'auto-accept', 'rerevolve', 'quota'];

interface CDPPage {
    id: string;
    webSocketDebuggerUrl: string;
    title: string;
    type: string;
}

interface CDPConnection {
    ws: WebSocket;
    injected: boolean;
}

export class AutoAcceptService implements vscode.Disposable {
    private connections: Map<string, CDPConnection> = new Map();
    private _enabled = false;
    private pollTimer: NodeJS.Timeout | null = null;
    private msgId = 1;
    
    // 상태 변경 이벤트
    private readonly _onStatusChange = new vscode.EventEmitter<boolean>();
    public readonly onStatusChange = this._onStatusChange.event;
    
    // 통계
    private stats = {
        codeAccepted: 0,
        terminalAccepted: 0,
        blockedCommands: 0,
    };
    private lastClickFeedback: number | null = null;
    private hasShownActiveFeedback = false;  // 활성화 피드백 표시 여부

    get isEnabled(): boolean {
        return this._enabled;
    }

    async start(): Promise<void> {
        if (this._enabled) return;
        
        // CDP 사용 가능 여부 확인
        const cdpAvailable = await this.isCDPAvailable();
        if (!cdpAvailable) {
            const action = await vscode.window.showWarningMessage(
                'CDP가 활성화되지 않았습니다. 자동 설정하시겠습니까?',
                '자동 설정',
                '수동 가이드',
                '취소'
            );
            if (action === '자동 설정') {
                const success = await this.setupCDP();
                if (success) {
                    vscode.window.showInformationMessage('Antigravity를 재시작한 후 다시 시도해주세요.');
                }
            } else if (action === '수동 가이드') {
                this.showSetupGuide();
            }
            return;
        }
        
        this._enabled = true;
        this._onStatusChange.fire(true);
        
        // 메인 폴링 시작
        this.pollTimer = setInterval(async () => {
            await this.poll();
        }, 1000);
        
        console.log('ReRevolve: Auto-Accept 활성화 🚀 (CDP 모드)');
        vscode.window.showInformationMessage('🚀 Auto-Accept 활성화! (CDP 모드)');
    }

    stop(): void {
        if (!this._enabled) return;
        
        this._enabled = false;
        this._onStatusChange.fire(false);
        this.hasShownActiveFeedback = false;  // 피드백 플래그 리셋
        
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        
        // 모든 연결 정리
        for (const [id, conn] of this.connections) {
            try {
                conn.ws.close();
            } catch {}
        }
        this.connections.clear();
        
        console.log('ReRevolve: Auto-Accept 비활성화');
        vscode.window.showInformationMessage('⏹️ Auto-Accept 비활성화');
    }

    toggle(): boolean {
        if (this._enabled) {
            this.stop();
        } else {
            this.start();
        }
        return this._enabled;
    }

    private async poll(): Promise<void> {
        if (!this._enabled) return;
        
        // [Removed] VS Code 명령어 자동 실행 - Ctrl+Alt+P 시 열린 창이 사라지는 부작용
        // 기존: ANTIGRAVITY_ACCEPT_COMMANDS 반복 실행 → 열린 파일이 자동 accept되면서 창이 닫힘
        
        // CDP DOM 클릭 (Accept All 버튼 등)
        for (let port = BASE_PORT - PORT_RANGE; port <= BASE_PORT + PORT_RANGE; port++) {
            try {
                // (A) 기존 page-level 연결 (page/webview/iframe/worker)
                const pages = await this.getPages(port);
                for (const page of pages) {
                    const id = `${port}:${page.id}`;
                    if (!this.connections.has(id)) {
                        await this.connect(id, page.webSocketDebuggerUrl);
                    }
                    await this.executeAutoAccept(id);
                }
                
                // (B) browser-level WebSocket 연결 (메인 UI 접근용)
                await this.connectAndEvalViaBrowser(port);
            } catch {}
        }
    }

    /**
     * Browser-level WebSocket으로 메인 Electron 창에 접근하여 Accept 스크립트 실행
     * /json/list에 page가 안 나오는 Electron 앱 (Antigravity) 대응
     */
    private async connectAndEvalViaBrowser(port: number): Promise<void> {
        const browserId = `browser:${port}`;
        
        // 이미 연결되어 있으면 바로 실행
        if (this.connections.has(browserId)) {
            await this.executeAutoAcceptViaBrowser(browserId);
            return;
        }
        
        // /json/version에서 browser WebSocket URL 가져오기
        try {
            const versionInfo = await this.getVersionInfo(port);
            if (versionInfo?.webSocketDebuggerUrl) {
                const connected = await this.connect(browserId, versionInfo.webSocketDebuggerUrl);
                if (connected) {
                    await this.executeAutoAcceptViaBrowser(browserId);
                }
            }
        } catch {}
    }

    /**
     * /json/version에서 browser WebSocket URL 가져오기
     */
    private getVersionInfo(port: number): Promise<{ webSocketDebuggerUrl: string } | null> {
        return new Promise((resolve) => {
            const req = http.get({
                hostname: '127.0.0.1',
                port,
                path: '/json/version',
                timeout: 500
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        });
    }

    /**
     * Browser-level WebSocket에서 Target.getTargets → 각 page에 attachToTarget → Runtime.evaluate
     */
    private async executeAutoAcceptViaBrowser(browserId: string): Promise<void> {
        const conn = this.connections.get(browserId);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;

        try {
            // 모든 타겟 조회
            const targetsResult = await this.sendCDP(conn, 'Target.getTargets', {});
            if (!targetsResult?.targetInfos) return;

            // page 타입 타겟 필터링 (Electron 메인 창)
            const pageTargets = targetsResult.targetInfos.filter(
                (t: any) => t.type === 'page' && !t.url?.startsWith('devtools://')
            );

            for (const target of pageTargets) {
                try {
                    // 타겟에 attach (이미 attached면 에러 → catch에서 무시)
                    const attachResult = await this.sendCDP(conn, 'Target.attachToTarget', {
                        targetId: target.targetId,
                        flatten: true
                    });

                    const sessionId = attachResult?.sessionId;
                    if (!sessionId) continue;

                    // 해당 세션에서 Accept 스크립트 실행
                    const script = this.getAcceptScript();
                    const evalResult = await this.sendCDP(conn, 'Runtime.evaluate', {
                        expression: script,
                        userGesture: true,
                        awaitPromise: true
                    }, sessionId);

                    if (evalResult?.result?.value > 0) {
                        this.stats.codeAccepted += evalResult.result.value;
                        console.log(`ReRevolve CDP (browser): Clicked ${evalResult.result.value} buttons via Target`);
                        const now = Date.now();
                        if (!this.lastClickFeedback || now - this.lastClickFeedback > 3000) {
                            vscode.window.setStatusBarMessage(`✅ Accept All: ${evalResult.result.value} 버튼 클릭`, 2000);
                            this.lastClickFeedback = now;
                        }
                    }
                } catch {}
            }
        } catch (err) {
            console.error('ReRevolve CDP (browser): Target evaluation error', err);
        }
    }

    /**
     * CDP 메시지 전송 헬퍼 (sessionId 지원)
     */
    private sendCDP(conn: CDPConnection, method: string, params: any, sessionId?: string): Promise<any> {
        return new Promise((resolve, reject) => {
            if (conn.ws.readyState !== WebSocket.OPEN) {
                return resolve(null);
            }
            const currentId = this.msgId++;
            const timeout = setTimeout(() => resolve(null), 2000);
            
            const onMessage = (data: WebSocket.Data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id === currentId) {
                        conn.ws.off('message', onMessage);
                        clearTimeout(timeout);
                        resolve(msg.result);
                    }
                } catch {}
            };
            
            conn.ws.on('message', onMessage);
            const message: any = { id: currentId, method, params };
            if (sessionId) {
                message.sessionId = sessionId;
            }
            conn.ws.send(JSON.stringify(message));
        });
    }

    /**
     * Accept 스크립트 생성 (iframe 내부 탐색 포함)
     * Reddit r/google_antigravity 발견: Accept 버튼은 iframe 안에 있음
     * className에 'bg-ide-button-bac' 또는 'hover:bg-ide-button-hover' 포함
     */
    private getAcceptScript(): string {
        return `
            (function() {
                const acceptPatterns = ${JSON.stringify(ACCEPT_PATTERNS)};
                const rejectPatterns = ${JSON.stringify(REJECT_PATTERNS)};
                
                function isAcceptButton(el) {
                    const text = (el.textContent || '').trim().toLowerCase();
                    if (text.length === 0 || text.length > 50) return false;
                    if (rejectPatterns.some(r => text.includes(r))) return false;
                    
                    const className = (el.className || '').toString();
                    
                    // Antigravity 전용: IDE 버튼 클래스 확인
                    const isIdeButton = className.includes('hover:bg-ide-button-hover') ||
                                       className.includes('bg-ide-button-bac');
                    
                    // 텍스트 패턴 매칭 (IDE 버튼이면 accept 텍스트만 있으면 OK)
                    const hasAcceptText = acceptPatterns.some(p => text.includes(p));
                    if (!hasAcceptText) return false;
                    
                    // 보이는 버튼인지 확인
                    return el.offsetWidth > 0 && el.offsetHeight > 0 && !el.disabled;
                }
                
                let clicked = 0;
                
                // 1. 메인 document에서 탐색
                document.querySelectorAll('button, [role="button"]').forEach(btn => {
                    if (isAcceptButton(btn)) {
                        btn.click();
                        clicked++;
                        console.log('[ReRevolve] Clicked (main):', btn.textContent.trim());
                    }
                });
                
                // 2. iframe 내부에서 탐색 (Antigravity Accept 버튼 위치)
                document.querySelectorAll('iframe').forEach(iframe => {
                    try {
                        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                        if (!iframeDoc) return;
                        
                        iframeDoc.querySelectorAll('button').forEach(btn => {
                            if (isAcceptButton(btn)) {
                                btn.click();
                                clicked++;
                                console.log('[ReRevolve] Clicked (iframe):', btn.textContent.trim());
                            }
                        });
                    } catch(e) { /* cross-origin iframe 접근 불가 */ }
                });
                
                return clicked;
            })();
        `;
    }

    private async isCDPAvailable(): Promise<boolean> {
        for (let port = BASE_PORT - PORT_RANGE; port <= BASE_PORT + PORT_RANGE; port++) {
            try {
                const pages = await this.getPages(port);
                if (pages.length > 0) return true;
            } catch {}
        }
        return false;
    }

    /**
     * CDP 연결 시도 (확장 시작 시 자동 호출용)
     */
    async tryConnect(): Promise<boolean> {
        return await this.isCDPAvailable();
    }

    /**
     * CDP 자동 설정 (처음 한 번만 실행)
     * VBS 스크립트 + 레지스트리 + 바로가기 모두 자동 설정
     */
    async setupCDPSilent(): Promise<boolean> {
        const fs = require('fs');
        const path = require('path');
        const { exec } = require('child_process');
        
        const userProfile = process.env.USERPROFILE || '';
        const localAppData = process.env.LOCALAPPDATA || '';
        const geminiDir = path.join(userProfile, '.gemini', 'antigravity');
        const vbsPath = path.join(geminiDir, 'antigravity_cdp.vbs');
        const markerPath = path.join(geminiDir, '.cdp_setup_done');
        
        // 이미 설정 완료된 경우 스킵
        if (fs.existsSync(markerPath) && fs.existsSync(vbsPath)) {
            console.log('ReRevolve: CDP 이미 설정됨 (스킵)');
            return true;
        }
        
        // Antigravity 경로 확인
        const antigravityPath = path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe');
        if (!fs.existsSync(antigravityPath)) {
            console.log('ReRevolve: Antigravity 경로를 찾을 수 없음');
            return false;
        }
        
        // 1. 폴더 생성
        if (!fs.existsSync(geminiDir)) {
            fs.mkdirSync(geminiDir, { recursive: true });
        }
        
        // 2. VBS 스크립트 생성 (동적 포트 할당 + 폴더 인자 지원)
        const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
Set objHTTP = CreateObject("MSXML2.XMLHTTP")

If WScript.Arguments.Count > 0 Then
    targetDir = WScript.Arguments(0)
Else
    targetDir = WshShell.CurrentDirectory
End If

' Antigravity 경로
antigravityPath = WshShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\\Programs\\Antigravity\\Antigravity.exe"

' 사용 가능한 포트 찾기 (9000-9009)
Dim port
For port = 9000 To 9009
    On Error Resume Next
    objHTTP.Open "GET", "http://127.0.0.1:" & port & "/json", False
    objHTTP.Send
    If Err.Number <> 0 Then
        On Error GoTo 0
        Exit For
    End If
    Err.Clear
    On Error GoTo 0
Next

' 폴더를 인자로 전달하여 Antigravity 실행
WshShell.Run """" & antigravityPath & """ --remote-debugging-port=" & port & " """ & targetDir & """", 0, False
`;
        
        fs.writeFileSync(vbsPath, vbsContent, 'utf8');
        console.log('ReRevolve: VBS 런처 생성됨:', vbsPath);
        
        // 3. 레지스트리 등록 + 바로가기 수정 (PowerShell)
        const psScript = `
$vbsPath = '${vbsPath.replace(/\\/g, '\\\\')}'
$iconPath = '${antigravityPath.replace(/\\/g, '\\\\')}'
$cdpArg = '--remote-debugging-port=9000'

# 레지스트리: 폴더 배경 우클릭
New-Item -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP' -Name '(Default)' -Value 'Antigravity (CDP)'
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP' -Name 'Icon' -Value $iconPath
New-Item -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP\\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP\\command' -Name '(Default)' -Value ('wscript.exe "' + $vbsPath + '" "%V"')

# 레지스트리: 폴더 직접 우클릭
New-Item -Path 'HKCU:\\Software\\Classes\\Directory\\shell\\AntigravityCDP' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\shell\\AntigravityCDP' -Name '(Default)' -Value 'Antigravity (CDP)'
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\shell\\AntigravityCDP' -Name 'Icon' -Value $iconPath
New-Item -Path 'HKCU:\\Software\\Classes\\Directory\\shell\\AntigravityCDP\\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\shell\\AntigravityCDP\\command' -Name '(Default)' -Value ('wscript.exe "' + $vbsPath + '" "%1"')

# 바로가기 수정 (있으면)
$WshShell = New-Object -ComObject WScript.Shell
$shortcuts = @(
    "$env:USERPROFILE\\Desktop\\Antigravity.lnk",
    "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Antigravity\\Antigravity.lnk"
)
foreach ($shortcut in $shortcuts) {
    if (Test-Path $shortcut) {
        $link = $WshShell.CreateShortcut($shortcut)
        if ($link.Arguments -notlike "*--remote-debugging-port*") {
            $link.Arguments = ($link.Arguments + " " + $cdpArg).Trim()
            $link.Save()
        }
    }
}

Write-Output 'OK'
`;
        
        return new Promise((resolve) => {
            const tempScript = path.join(userProfile, 'temp_cdp_setup.ps1');
            fs.writeFileSync(tempScript, psScript, 'utf8');
            
            exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempScript}"`, (error: any, stdout: string) => {
                try { fs.unlinkSync(tempScript); } catch (e) {}
                
                if (error) {
                    console.log('ReRevolve: CDP 자동 설정 실패:', error.message);
                    resolve(false);
                    return;
                }
                
                // 설정 완료 마커 생성
                fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
                
                console.log('ReRevolve: CDP 자동 설정 완료!');
                vscode.window.showInformationMessage(
                    '✅ CDP 자동 설정 완료! 우클릭 → "Antigravity (CDP)"로 재시작하면 Auto-Accept가 작동합니다.',
                    'OK'
                );
                resolve(true);
            });
        });
    }

    private getPages(port: number): Promise<CDPPage[]> {
        return new Promise((resolve) => {
            const req = http.get({
                hostname: '127.0.0.1',
                port,
                path: '/json/list',
                timeout: 500
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    try {
                        const pages = JSON.parse(body) as CDPPage[];
                        // page, webview, iframe, worker 모두 포함 (에디터 Diff Overlay 등)
                        resolve(pages.filter(p => 
                            p.webSocketDebuggerUrl && 
                            (p.type === 'page' || p.type === 'webview' || p.type === 'iframe' || p.type === 'worker')
                        ));
                    } catch { resolve([]); }
                });
            });
            req.on('error', () => resolve([]));
            req.on('timeout', () => { req.destroy(); resolve([]); });
        });
    }

    private async connect(id: string, url: string): Promise<boolean> {
        return new Promise((resolve) => {
            try {
                const ws = new WebSocket(url);
                
                ws.on('open', () => {
                    this.connections.set(id, { ws, injected: false });
                    console.log(`ReRevolve CDP: Connected to ${id}`);
                    resolve(true);
                });
                
                ws.on('error', () => resolve(false));
                
                ws.on('close', () => {
                    this.connections.delete(id);
                    console.log(`ReRevolve CDP: Disconnected from ${id}`);
                });
            } catch {
                resolve(false);
            }
        });
    }

    private async executeAutoAccept(id: string): Promise<void> {
        const conn = this.connections.get(id);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;
        
        // Accept 버튼 찾아서 클릭하는 스크립트 (디버그 모드)
        const script = `
            (function() {
                const acceptPatterns = ${JSON.stringify(ACCEPT_PATTERNS)};
                const rejectPatterns = ${JSON.stringify(REJECT_PATTERNS)};
                const DEBUG = true; // 디버그 로그 활성화
                
                function isAcceptButton(el) {
                    const text = (el.textContent || '').trim().toLowerCase();
                    if (text.length === 0 || text.length > 50) return false;
                    if (rejectPatterns.some(r => text.includes(r))) return false;
                    if (!acceptPatterns.some(p => text.includes(p))) return false;
                    
                    const style = window.getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style.display !== 'none' && 
                           rect.width > 0 && 
                           style.pointerEvents !== 'none' && 
                           !el.disabled;
                }
                
                let clicked = 0;
                // 더 넓은 선택자: 버튼, 클릭 가능한 요소들
                const selectors = 'button, [class*="button"], [class*="btn"], [role="button"], a[class*="action"], div[class*="action"], span[class*="action"]';
                const buttons = document.querySelectorAll(selectors);
                
                // 디버그: Accept 패턴과 일치하는 버튼만 로깅
                if (DEBUG) {
                    const matchingButtons = [];
                    buttons.forEach(btn => {
                        const text = (btn.textContent || '').trim().toLowerCase();
                        if (text.length > 0 && text.length <= 50) {
                            // "accept" 단어가 포함된 버튼만 로깅
                            if (text.includes('accept') || text.includes('deny') || text.includes('all')) {
                                matchingButtons.push({
                                    text: text.substring(0, 60),
                                    tag: btn.tagName,
                                    class: btn.className?.substring?.(0, 50) || '',
                                    isMatch: acceptPatterns.some(p => text.includes(p)),
                                    isReject: rejectPatterns.some(r => text.includes(r))
                                });
                            }
                        }
                    });
                    if (matchingButtons.length > 0) {
                        console.log('[ReRevolve DEBUG] Found buttons with accept/deny/all:', JSON.stringify(matchingButtons, null, 2));
                    }
                }
                
                buttons.forEach(btn => {
                    if (isAcceptButton(btn)) {
                        btn.dispatchEvent(new MouseEvent('click', { 
                            view: window, 
                            bubbles: true, 
                            cancelable: true 
                        }));
                        clicked++;
                        console.log('[ReRevolve] Clicked:', btn.textContent.trim());
                    }
                });
                return clicked;
            })();
        `;
        
        try {
            const result = await this.evaluate(id, script);
            if (result?.result?.value > 0) {
                this.stats.codeAccepted += result.result.value;
                console.log(`ReRevolve CDP: Clicked ${result.result.value} buttons`);
                // 사용자에게 피드백 (throttle: 3초에 한 번만)
                const now = Date.now();
                if (!this.lastClickFeedback || now - this.lastClickFeedback > 3000) {
                    vscode.window.setStatusBarMessage(`✅ Auto-Accept: ${result.result.value} 버튼 클릭`, 2000);
                    this.lastClickFeedback = now;
                }
            }
        } catch (err) {
            console.error('ReRevolve CDP: Execution error', err);
        }
    }

    private evaluate(id: string, expression: string): Promise<any> {
        const conn = this.connections.get(id);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
            return Promise.resolve(null);
        }
        
        return new Promise((resolve, reject) => {
            const currentId = this.msgId++;
            const timeout = setTimeout(() => reject(new Error('CDP Timeout')), 2000);
            
            const onMessage = (data: WebSocket.Data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id === currentId) {
                        conn.ws.off('message', onMessage);
                        clearTimeout(timeout);
                        resolve(msg.result);
                    }
                } catch {}
            };
            
            conn.ws.on('message', onMessage);
            conn.ws.send(JSON.stringify({
                id: currentId,
                method: 'Runtime.evaluate',
                params: { 
                    expression, 
                    userGesture: true, 
                    awaitPromise: true 
                }
            }));
        });
    }

    getStats() {
        return { ...this.stats };
    }

    /**
     * CDP 자동 설정 - VBS 스크립트 생성 + 우클릭 메뉴 등록
     */
    async setupCDP(): Promise<boolean> {
        const fs = require('fs');
        const path = require('path');
        const { exec } = require('child_process');
        
        const userProfile = process.env.USERPROFILE || '';
        const localAppData = process.env.LOCALAPPDATA || '';
        const geminiDir = path.join(userProfile, '.gemini', 'antigravity');
        const vbsPath = path.join(geminiDir, 'antigravity_cdp.vbs');
        
        // Antigravity 경로 확인
        const defaultPath = path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe');
        
        if (!fs.existsSync(defaultPath)) {
            const action = await vscode.window.showWarningMessage(
                `Antigravity가 기본 경로에 없습니다.\n${defaultPath}`,
                '경로 직접 입력',
                '취소'
            );
            if (action === '경로 직접 입력') {
                const customPath = await vscode.window.showInputBox({
                    prompt: 'Antigravity.exe 전체 경로를 입력하세요',
                    placeHolder: 'C:\\경로\\Antigravity.exe',
                    validateInput: (value) => {
                        if (!value.endsWith('.exe')) return '.exe 파일을 지정해주세요';
                        return null;
                    }
                });
                if (customPath && fs.existsSync(customPath)) {
                    return this.createCDPLauncher(customPath, vbsPath, geminiDir);
                } else {
                    vscode.window.showErrorMessage('파일을 찾을 수 없습니다.');
                    return false;
                }
            }
            return false;
        }
        
        return this.createCDPLauncher(defaultPath, vbsPath, geminiDir);
    }

    /**
     * VBS 런처 생성 및 레지스트리 등록
     */
    private async createCDPLauncher(antigravityPath: string, vbsPath: string, geminiDir: string): Promise<boolean> {
        const fs = require('fs');
        const { exec } = require('child_process');
        
        // 1. 폴더 생성
        if (!fs.existsSync(geminiDir)) {
            fs.mkdirSync(geminiDir, { recursive: true });
        }
        
        // 2. VBS 스크립트 생성 (창 없이 실행)
        const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
If WScript.Arguments.Count > 0 Then
    targetDir = WScript.Arguments(0)
Else
    targetDir = WshShell.CurrentDirectory
End If
WshShell.CurrentDirectory = targetDir
WshShell.Run """${antigravityPath.replace(/\\/g, '\\\\')}""" & " --remote-debugging-port=9000", 0, False
`;
        
        fs.writeFileSync(vbsPath, vbsContent, 'utf8');
        console.log('ReRevolve: VBS 런처 생성됨:', vbsPath);
        
        // 3. 레지스트리 등록 (PowerShell)
        const psScript = `
$vbsPath = '${vbsPath.replace(/\\/g, '\\\\')}'
$iconPath = '${antigravityPath.replace(/\\/g, '\\\\')}'

# 폴더 배경 우클릭
New-Item -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP' -Name '(Default)' -Value 'Antigravity (CDP)'
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP' -Name 'Icon' -Value $iconPath
New-Item -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP\\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP\\command' -Name '(Default)' -Value ('wscript.exe "' + $vbsPath + '" "%V"')

# 폴더 직접 우클릭
New-Item -Path 'HKCU:\\Software\\Classes\\Directory\\shell\\AntigravityCDP' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\shell\\AntigravityCDP' -Name '(Default)' -Value 'Antigravity (CDP)'
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\shell\\AntigravityCDP' -Name 'Icon' -Value $iconPath
New-Item -Path 'HKCU:\\Software\\Classes\\Directory\\shell\\AntigravityCDP\\command' -Force | Out-Null
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\shell\\AntigravityCDP\\command' -Name '(Default)' -Value ('wscript.exe "' + $vbsPath + '" "%1"')

Write-Output 'OK'
`;
        
        return new Promise((resolve) => {
            exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, (error: any, stdout: string) => {
                if (error) {
                    vscode.window.showErrorMessage(`CDP 설정 실패: ${error.message}`);
                    resolve(false);
                    return;
                }
                
                vscode.window.showInformationMessage(
                    '✅ CDP 설정 완료! 우클릭 → "Antigravity (CDP)"로 재시작해주세요.',
                    'OK'
                );
                console.log('ReRevolve: 레지스트리 등록 완료');
                resolve(true);
            });
        });
    }

    /**
     * 수동 설정 가이드 표시
     */
    showSetupGuide(): void {
        const userProfile = process.env.USERPROFILE || '';
        const localAppData = process.env.LOCALAPPDATA || '';
        
        const panel = vscode.window.createWebviewPanel(
            'cdpSetupGuide',
            'CDP 수동 설정 가이드',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        
        panel.webview.html = `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 20px; line-height: 1.6; }
        h1 { color: #4fc3f7; }
        h2 { color: #81c784; margin-top: 24px; }
        code { background: #333; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
        pre { background: #1e1e1e; padding: 12px; border-radius: 8px; overflow-x: auto; }
        .path { color: #ffb74d; }
        .note { background: #2d2d2d; padding: 12px; border-left: 4px solid #4fc3f7; margin: 16px 0; }
    </style>
</head>
<body>
    <h1>🛠️ Auto-Accept CDP 수동 설정 가이드</h1>
    
    <h2>1. Antigravity 설치 경로 확인</h2>
    <p>기본 설치 경로:</p>
    <pre class="path">${localAppData}\\Programs\\Antigravity\\Antigravity.exe</pre>
    
    <div class="note">
        ⚠️ 다른 경로에 설치했다면 해당 경로를 기억해주세요.
    </div>
    
    <h2>2. VBS 런처 파일 생성</h2>
    <p>아래 내용으로 파일 생성:</p>
    <pre class="path">${userProfile}\\.gemini\\antigravity\\antigravity_cdp.vbs</pre>
    <pre>Set WshShell = CreateObject("WScript.Shell")
If WScript.Arguments.Count > 0 Then
    targetDir = WScript.Arguments(0)
Else
    targetDir = WshShell.CurrentDirectory
End If
WshShell.CurrentDirectory = targetDir
WshShell.Run """[Antigravity 경로]""" & " --remote-debugging-port=9000", 0, False</pre>
    
    <h2>3. 우클릭 메뉴 등록</h2>
    <p>PowerShell (관리자)에서 실행:</p>
    <pre>$vbsPath = "${userProfile}\\.gemini\\antigravity\\antigravity_cdp.vbs"
New-Item -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP' -Force
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP' -Name '(Default)' -Value 'Antigravity (CDP)'
New-Item -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP\\command' -Force
Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\AntigravityCDP\\command' -Name '(Default)' -Value ('wscript.exe "' + $vbsPath + '" "%V"')</pre>
    
    <h2>4. 확인</h2>
    <p>폴더에서 우클릭 → <b>"Antigravity (CDP)"</b> 메뉴가 보이면 성공!</p>
    <p>실행 후 브라우저에서 <a href="http://127.0.0.1:9000/json/list">http://127.0.0.1:9000/json/list</a> 접속하여 JSON이 보이면 CDP 작동 중입니다.</p>
</body>
</html>
        `;
    }

    /**
     * CDP 설정 제거 - Antigravity 바로가기에서 옵션 제거
     */
    async removeCDP(): Promise<boolean> {
        const fs = require('fs');
        const path = require('path');
        const { exec } = require('child_process');
        
        const userProfile = process.env.USERPROFILE || '';
        
        const psScript = `
$WshShell = New-Object -ComObject WScript.Shell

$shortcuts = @(
    "$env:USERPROFILE\\Desktop\\Antigravity.lnk",
    "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Antigravity.lnk"
)

$modified = 0
foreach ($shortcut in $shortcuts) {
    if (Test-Path $shortcut) {
        $link = $WshShell.CreateShortcut($shortcut)
        if ($link.Arguments -like "*--remote-debugging-port*") {
            $link.Arguments = ($link.Arguments -replace '--remote-debugging-port=\\d+', '').Trim()
            $link.Save()
            $modified++
        }
    }
}

Write-Output $modified
`;
        
        return new Promise((resolve) => {
            const tempScript = path.join(userProfile, 'temp_cdp_remove.ps1');
            fs.writeFileSync(tempScript, psScript, 'utf8');
            
            exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempScript}"`, (error: any, stdout: string) => {
                try { fs.unlinkSync(tempScript); } catch (e) {}
                
                if (error) {
                    vscode.window.showErrorMessage(`CDP 제거 실패: ${error.message}`);
                    resolve(false);
                    return;
                }
                
                const modified = parseInt(stdout.trim()) || 0;
                if (modified > 0) {
                    vscode.window.showInformationMessage(
                        `✅ CDP 설정 제거됨! ${modified}개 바로가기에서 옵션 제거. 재시작 후 적용됩니다.`
                    );
                } else {
                    vscode.window.showInformationMessage('CDP 설정이 없거나 이미 제거되었습니다.');
                }
                resolve(modified > 0);
            });
        });
    }

    dispose(): void {
        this.stop();
        this._onStatusChange.dispose();
    }
}

