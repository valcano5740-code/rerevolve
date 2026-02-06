/**
 * Language Server Client - 활성 계정 빠른 감지
 * 
 * Antigravity Language Server에 HTTP로 연결하여 현재 활성 계정 정보를 가져옴
 * Toolkit for Antigravity의 ProcessFinder를 단순화한 버전
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as http from 'node:http';
import * as https from 'node:https';

const execAsync = promisify(exec);

interface LanguageServerInfo {
    port: number;
    csrfToken: string;
}

interface UserStatusResponse {
    userStatus?: {
        email?: string;
        name?: string;
        userTier?: {
            name?: string;
            description?: string;
        };
    };
}

export class LanguageServerClient {
    private serverInfo: LanguageServerInfo | null = null;
    private lastDetectTime: number = 0;
    private readonly DETECT_CACHE_MS = 30000; // 30초 캐시
    private readonly MAX_RETRIES = 3;
    private readonly RETRY_DELAY_MS = 1000;

    /**
     * 현재 활성 계정 이메일 가져오기 (3회 재시도)
     */
    async getCurrentEmail(): Promise<string | null> {
        let lastError: unknown = null;

        for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
            try {
                const info = await this.detectServer();
                if (!info) {
                    console.log(`ReRevolve LS: [${attempt}/${this.MAX_RETRIES}] Language Server not detected`);
                    if (attempt < this.MAX_RETRIES) {
                        await this.delay(this.RETRY_DELAY_MS);
                        continue;
                    }
                    this.logDiagnostics('Server not found after all retries');
                    return null;
                }

                const status = await this.fetchUserStatus(info);
                const email = status?.userStatus?.email;
                
                if (email) {
                    console.log(`ReRevolve LS: Active account detected: ${email}`);
                    return email.toLowerCase();
                }
                
                console.log(`ReRevolve LS: [${attempt}/${this.MAX_RETRIES}] No email in response`);
            } catch (err) {
                lastError = err;
                console.log(`ReRevolve LS: [${attempt}/${this.MAX_RETRIES}] Error:`, err);
            }

            if (attempt < this.MAX_RETRIES) {
                await this.delay(this.RETRY_DELAY_MS);
            }
        }

        this.logDiagnostics('All retries failed', lastError);
        return null;
    }

    /**
     * 진단 로그 (디버깅용)
     */
    private logDiagnostics(reason: string, error?: unknown): void {
        console.log('=== ReRevolve LS Diagnostics ===');
        console.log(`Reason: ${reason}`);
        console.log(`Platform: ${process.platform}`);
        console.log(`PID: ${process.pid}, PPID: ${process.ppid}`);
        console.log(`Cached server: ${this.serverInfo ? `port ${this.serverInfo.port}` : 'none'}`);
        if (error) console.log(`Last error:`, error);
        console.log('================================');
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Language Server 감지 (포트 + CSRF 토큰)
     * 다중 창 지원: 현재 확장 프로세스와 관련된 Language Server만 감지
     */
    private async detectServer(): Promise<LanguageServerInfo | null> {
        // 캐시된 정보가 있고 30초 이내면 재사용
        if (this.serverInfo && Date.now() - this.lastDetectTime < this.DETECT_CACHE_MS) {
            return this.serverInfo;
        }

        try {
            const myPid = process.pid;
            const myPpid = process.ppid;

            // Windows: PowerShell로 모든 language_server 프로세스 정보 추출
            if (process.platform === 'win32') {
                const { stdout } = await execAsync(
                    `Get-WmiObject Win32_Process -Filter "name='language_server_windows_x64.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine | Format-List`,
                    { shell: 'powershell.exe', timeout: 10000 }
                );

                // 여러 프로세스가 있을 수 있음 - 관련된 것만 필터링
                const processes = this.parseWindowsProcesses(stdout);
                const matched = this.findRelatedProcess(processes, myPid, myPpid);
                
                if (matched) {
                    this.serverInfo = matched;
                    this.lastDetectTime = Date.now();
                    console.log(`ReRevolve LS: Server detected on port ${matched.port} (matched by PID relationship)`);
                    return matched;
                }

                // 관계 매칭 실패 시 첫 번째 사용 (단일 창인 경우)
                if (processes.length === 1) {
                    this.serverInfo = processes[0];
                    this.lastDetectTime = Date.now();
                    console.log(`ReRevolve LS: Server detected on port ${processes[0].port} (single instance)`);
                    return processes[0];
                }

                if (processes.length > 1) {
                    console.log(`ReRevolve LS: Multiple servers found (${processes.length}), but couldn't match to current window`);
                }
            }
            // macOS/Linux
            else {
                const processName = process.platform === 'darwin' 
                    ? 'language_server_macos' 
                    : 'language_server_linux';
                
                const { stdout } = await execAsync(
                    `ps -eo pid,ppid,command | grep "${processName}" | grep -v grep`,
                    { timeout: 10000 }
                );

                const processes = this.parseUnixProcesses(stdout);
                const matched = this.findRelatedProcess(processes, myPid, myPpid);
                
                if (matched) {
                    this.serverInfo = matched;
                    this.lastDetectTime = Date.now();
                    console.log(`ReRevolve LS: Server detected on port ${matched.port}`);
                    return matched;
                }

                if (processes.length === 1) {
                    this.serverInfo = processes[0];
                    this.lastDetectTime = Date.now();
                    return processes[0];
                }
            }
        } catch {
            // 프로세스 없음 또는 타임아웃
        }

        return null;
    }

    /**
     * Windows 프로세스 목록 파싱
     */
    private parseWindowsProcesses(stdout: string): (LanguageServerInfo & { pid: number; ppid: number })[] {
        const results: (LanguageServerInfo & { pid: number; ppid: number })[] = [];
        
        // 각 프로세스 블록 분리
        const blocks = stdout.split(/\r?\n\r?\n/).filter(b => b.trim());
        
        for (const block of blocks) {
            const pidMatch = block.match(/ProcessId\s*:\s*(\d+)/);
            const ppidMatch = block.match(/ParentProcessId\s*:\s*(\d+)/);
            const cmdMatch = block.match(/CommandLine\s*:\s*(.+)/s);
            
            if (pidMatch && ppidMatch && cmdMatch) {
                const info = this.parseCommandLine(cmdMatch[1]);
                if (info) {
                    results.push({
                        ...info,
                        pid: parseInt(pidMatch[1], 10),
                        ppid: parseInt(ppidMatch[1], 10)
                    });
                }
            }
        }
        
        return results;
    }

    /**
     * Unix 프로세스 목록 파싱
     */
    private parseUnixProcesses(stdout: string): (LanguageServerInfo & { pid: number; ppid: number })[] {
        const results: (LanguageServerInfo & { pid: number; ppid: number })[] = [];
        
        for (const line of stdout.split('\n').filter(l => l.trim())) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 3) {
                const pid = parseInt(parts[0], 10);
                const ppid = parseInt(parts[1], 10);
                const cmdLine = parts.slice(2).join(' ');
                
                const info = this.parseCommandLine(cmdLine);
                if (info) {
                    results.push({ ...info, pid, ppid });
                }
            }
        }
        
        return results;
    }

    /**
     * 현재 확장과 관련된 프로세스 찾기 (PID/PPID 매칭)
     */
    private findRelatedProcess(
        processes: (LanguageServerInfo & { pid: number; ppid: number })[],
        myPid: number,
        myPpid: number
    ): LanguageServerInfo | null {
        // 1. 직접 자식 (우리 PID의 자식)
        const child = processes.find(p => p.ppid === myPid);
        if (child) return { port: child.port, csrfToken: child.csrfToken };

        // 2. 형제 (같은 부모)
        const sibling = processes.find(p => p.ppid === myPpid);
        if (sibling) return { port: sibling.port, csrfToken: sibling.csrfToken };

        // 3. 조상 관계 (더 넓은 탐색 - 간단히 생략)
        return null;
    }

    /**
     * 명령줄에서 포트와 CSRF 토큰 추출
     */
    private parseCommandLine(cmdLine: string): LanguageServerInfo | null {
        // --agent_port=12345 또는 -agent_port 12345
        const portMatch = cmdLine.match(/--?agent_port[=\s]+(\d+)/);
        // --csrf_token=xxx 또는 -csrf_token xxx
        const tokenMatch = cmdLine.match(/--?csrf_token[=\s]+([a-f0-9-]+)/i);

        if (portMatch && tokenMatch) {
            return {
                port: parseInt(portMatch[1], 10),
                csrfToken: tokenMatch[1]
            };
        }

        return null;
    }

    /**
     * Language Server에서 사용자 상태 조회
     */
    private async fetchUserStatus(info: LanguageServerInfo): Promise<UserStatusResponse | null> {
        const body = JSON.stringify({
            metadata: {
                ideName: 'antigravity',
                extensionName: 'antigravity',
                locale: 'en'
            }
        });

        // HTTPS 먼저 시도, 실패하면 HTTP
        for (const protocol of ['https', 'http'] as const) {
            try {
                const result = await this.httpRequest(protocol, info, body);
                if (result) return result;
            } catch {
                // 다음 프로토콜 시도
            }
        }

        return null;
    }

    /**
     * HTTP 요청 실행
     */
    private httpRequest(
        protocol: 'http' | 'https',
        info: LanguageServerInfo,
        body: string
    ): Promise<UserStatusResponse | null> {
        return new Promise((resolve) => {
            const options = {
                hostname: '127.0.0.1',
                port: info.port,
                path: '/v1internal:getUserStatus',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': info.csrfToken
                },
                timeout: 5000,
                rejectUnauthorized: false // 자체 서명 인증서 허용
            };

            const client = protocol === 'https' ? https : http;
            const req = client.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data) as UserStatusResponse);
                    } catch {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null));
            req.on('timeout', () => {
                req.destroy();
                resolve(null);
            });

            req.write(body);
            req.end();
        });
    }

    /**
     * 캐시 무효화 (강제 재감지)
     */
    invalidateCache(): void {
        this.serverInfo = null;
        this.lastDetectTime = 0;
    }
}
