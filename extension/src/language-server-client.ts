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
    protocol?: 'http' | 'https';
    statusPath?: string;
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
    private readonly DETECT_CACHE_MS = 60000; // 60초 (PowerShell 호출 최소화)
    private readonly MAX_RETRIES = 2;
    private readonly RETRY_DELAY_MS = 1000;
    private detectPromise: Promise<LanguageServerInfo | null> | null = null; // mutex

    /**
     * 현재 캐시된 LS 서버 정보 반환 (PowerShell 호출 없음)
     * quota-service에서 재사용하기 위한 getter
     */
    getCachedServerInfo(): LanguageServerInfo | null {
        return this.serverInfo;
    }

    /**
     * 경량 이메일 조회 — 캐시된 서버 정보로 HTTP만 호출 (PowerShell 없음)
     * 15초 폴링에서 사용. 서버 정보가 없으면 null 반환 (full detect는 하지 않음)
     */
    async getEmailQuick(): Promise<string | null> {
        if (!this.serverInfo) {
            return null; // 서버 정보 없으면 스킵 (full detect는 getCurrentEmail에서)
        }

        try {
            const status = await this.fetchUserStatus(this.serverInfo);
            const email = status?.userStatus?.email;
            if (email) {
                return email.toLowerCase();
            }
        } catch {
            // HTTP 실패 → 서버가 죽었을 수 있으므로 캐시 무효화
            this.serverInfo = null;
            this.lastDetectTime = 0;
        }

        return null;
    }

    /**
     * 현재 활성 계정 이메일 가져오기 (2회 재시도, 서버 재감지 포함)
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
     * mutex로 동시 호출 방지 — PowerShell 프로세스 폭증 차단
     */
    private async detectServer(): Promise<LanguageServerInfo | null> {
        // 캐시된 정보가 있고 120초 이내면 재사용
        if (this.serverInfo && Date.now() - this.lastDetectTime < this.DETECT_CACHE_MS) {
            return this.serverInfo;
        }

        // 이미 감지 중이라면 기존 Promise 재사용 (동시 호출 방지)
        if (this.detectPromise) {
            return this.detectPromise;
        }

        this.detectPromise = this._detectServerImpl();
        try {
            return await this.detectPromise;
        } finally {
            this.detectPromise = null;
        }
    }

    private async _detectServerImpl(): Promise<LanguageServerInfo | null> {
        try {
            // Windows: PowerShell로 language_server 프로세스 명령줄 추출
            if (process.platform === 'win32') {
                const { stdout } = await execAsync(
                    `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'language_server_windows_x64.exe' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
                    { shell: 'powershell.exe', timeout: 10000 }
                );

                const info = await this.detectWindowsServer(stdout);
                if (info) {
                    this.serverInfo = info;
                    this.lastDetectTime = Date.now();
                    console.log(`ReRevolve LS: Server detected on ${info.protocol || 'http'} port ${info.port}`);
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

    private async detectWindowsServer(stdout: string): Promise<LanguageServerInfo | null> {
        const processes = this.parseWindowsProcesses(stdout);

        // 워크스페이스가 붙은 LS가 현재 창의 실제 사용자 상태를 가장 잘 반영한다.
        processes.sort((a, b) => Number(b.commandLine.includes('--workspace_id')) - Number(a.commandLine.includes('--workspace_id')));

        for (const proc of processes) {
            const csrfToken = this.extractArg(proc.commandLine, 'csrf_token');
            if (!csrfToken) continue;

            const listenPorts = await this.getListeningPorts(proc.processId);
            const validated = await this.findWorkingStatusEndpoint(listenPorts, csrfToken);
            if (validated) return validated;

            const legacy = this.parseCommandLine(proc.commandLine);
            if (legacy) return legacy;
        }

        return null;
    }

    private parseWindowsProcesses(stdout: string): Array<{ processId: number; commandLine: string }> {
        const trimmed = stdout.trim();
        if (!trimmed) return [];

        try {
            const parsed = JSON.parse(trimmed) as any;
            const rows = Array.isArray(parsed) ? parsed : [parsed];
            return rows
                .map(row => ({
                    processId: Number(row.ProcessId),
                    commandLine: String(row.CommandLine || '')
                }))
                .filter(row => row.processId > 0 && row.commandLine.length > 0);
        } catch {
            const commandLines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            return commandLines.map((commandLine, index) => ({ processId: index, commandLine }));
        }
    }

    private async getListeningPorts(processId: number): Promise<number[]> {
        if (!processId) return [];

        try {
            const { stdout } = await execAsync(
                `Get-NetTCPConnection -OwningProcess ${processId} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort`,
                { shell: 'powershell.exe', timeout: 10000 }
            );
            return [...new Set(stdout.split(/\s+/).map(v => parseInt(v, 10)).filter(v => Number.isFinite(v)))]
                .sort((a, b) => a - b);
        } catch {
            return [];
        }
    }

    private async findWorkingStatusEndpoint(ports: number[], csrfToken: string): Promise<LanguageServerInfo | null> {
        const paths = [
            '/exa.language_server_pb.LanguageServerService/GetUserStatus',
            '/v1internal:getUserStatus'
        ];

        // Antigravity 1.23+는 실제 HTTPS/HTTP 포트를 명령줄에 노출하지 않고 Listen 포트로만 확인된다.
        for (const port of ports) {
            for (const protocol of ['https', 'http'] as const) {
                for (const statusPath of paths) {
                    const status = await this.fetchUserStatus({ port, csrfToken, protocol, statusPath });
                    if (status?.userStatus?.email) {
                        return { port, csrfToken, protocol, statusPath };
                    }
                }
            }
        }

        return null;
    }

    private extractArg(cmdLine: string, name: string): string | null {
        const match = cmdLine.match(new RegExp(`--?${name}[=\\s]+([^\\s]+)`, 'i'));
        return match?.[1] || null;
    }



    /**
     * 명령줄에서 포트와 CSRF 토큰 추출
     */
    private parseCommandLine(cmdLine: string): LanguageServerInfo | null {
        // --agent_port=12345 또는 -agent_port 12345 (Antigravity 1.20.x)
        // --https_server_port=12345 (일부 고정 포트/재시작 시나리오)
        const portMatch = cmdLine.match(/--?agent_port[=\s]+(\d+)/)
            || cmdLine.match(/--?https_server_port[=\s]+(\d+)/);
        // --csrf_token=xxx 또는 -csrf_token xxx
        const tokenMatch = cmdLine.match(/--?csrf_token[=\s]+([a-f0-9-]+)/i);

        if (portMatch && tokenMatch) {
            return {
                port: parseInt(portMatch[1], 10),
                csrfToken: tokenMatch[1],
                protocol: 'https',
                statusPath: '/exa.language_server_pb.LanguageServerService/GetUserStatus'
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

        if (info.protocol && info.statusPath) {
            return this.httpRequest(info.protocol, info, body, info.statusPath);
        }

        // HTTPS 먼저 시도, 실패하면 HTTP
        for (const protocol of ['https', 'http'] as const) {
            for (const path of ['/exa.language_server_pb.LanguageServerService/GetUserStatus', '/v1internal:getUserStatus']) {
                try {
                    const result = await this.httpRequest(protocol, info, body, path);
                    if (result) return result;
                } catch {
                    // 다음 프로토콜/경로 시도
                }
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
        body: string,
        requestPath: string
    ): Promise<UserStatusResponse | null> {
        return new Promise((resolve) => {
            const options = {
                hostname: '127.0.0.1',
                port: info.port,
                path: requestPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
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
