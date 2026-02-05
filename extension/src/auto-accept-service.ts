/**
 * Auto-Accept Service - CDP 기반 구현
 * AAA(Auto Accept Agent) 방식 참고
 * v3.0: CDP WebSocket을 통한 직접 DOM 조작
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

// Accept 버튼 텍스트 패턴
const ACCEPT_PATTERNS = ['accept', 'run', 'retry', 'apply', 'execute', 'confirm', 'allow once', 'allow'];
const REJECT_PATTERNS = ['skip', 'reject', 'cancel', 'close', 'refine'];

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
        
        // 포트 범위 스캔
        for (let port = BASE_PORT - PORT_RANGE; port <= BASE_PORT + PORT_RANGE; port++) {
            try {
                const pages = await this.getPages(port);
                for (const page of pages) {
                    const id = `${port}:${page.id}`;
                    
                    // 새 페이지면 연결
                    if (!this.connections.has(id)) {
                        await this.connect(id, page.webSocketDebuggerUrl);
                    }
                    
                    // 스크립트 실행
                    await this.executeAutoAccept(id);
                }
            } catch {}
        }
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
                        // page, webview, iframe 모두 포함 (에디터 Diff Overlay 등)
                        resolve(pages.filter(p => 
                            p.webSocketDebuggerUrl && 
                            (p.type === 'page' || p.type === 'webview' || p.type === 'iframe')
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
        
        // Accept 버튼 찾아서 클릭하는 스크립트
        const script = `
            (function() {
                const acceptPatterns = ${JSON.stringify(ACCEPT_PATTERNS)};
                const rejectPatterns = ${JSON.stringify(REJECT_PATTERNS)};
                
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
                const buttons = document.querySelectorAll('button, [class*="button"]');
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

