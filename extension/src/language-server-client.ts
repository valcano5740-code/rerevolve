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
     * 모든 창이 같은 계정을 공유하므로 첫 번째 프로세스 사용
     */
    private async detectServer(): Promise<LanguageServerInfo | null> {
        // 캐시된 정보가 있고 30초 이내면 재사용
        if (this.serverInfo && Date.now() - this.lastDetectTime < this.DETECT_CACHE_MS) {
            return this.serverInfo;
        }

        try {
            // Windows: PowerShell로 language_server 프로세스 명령줄 추출
            if (process.platform === 'win32') {
                const { stdout } = await execAsync(
                    `Get-WmiObject Win32_Process -Filter "name='language_server_windows_x64.exe'" | Select-Object CommandLine | Format-List`,
                    { shell: 'powershell.exe', timeout: 10000 }
                );

                const info = this.parseCommandLine(stdout);
                if (info) {
                    this.serverInfo = info;
                    this.lastDetectTime = Date.now();
                    console.log(`ReRevolve LS: Server detected on port ${info.port}`);
                    return info;
                }
            }
            // macOS/Linux
            else {
                const processName = process.platform === 'darwin' 
                    ? 'language_server_macos' 
                    : 'language_server_linux';
                
                const { stdout } = await execAsync(
                    `ps aux | grep "${processName}" | grep -v grep`,
                    { timeout: 10000 }
                );

                const info = this.parseCommandLine(stdout);
                if (info) {
                    this.serverInfo = info;
                    this.lastDetectTime = Date.now();
                    console.log(`ReRevolve LS: Server detected on port ${info.port}`);
                    return info;
                }
            }
        } catch {
            // 프로세스 없음 또는 타임아웃
        }

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
