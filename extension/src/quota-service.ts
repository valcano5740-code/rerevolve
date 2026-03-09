/**
 * Quota Service - CloudCode API + 로컬 LS API 하이브리드 쿼터 조회
 *
 * 활성 계정: 로컬 LS GetUserStatus (빠르고 부하 없음)
 * 비활성 계정: 기존 Google CloudCode API (원격)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';

const execAsync = promisify(exec);

export interface ModelQuota {
    displayName: string;
    model: string;
    remainingPercentage: number;
    resetTime: string | null;
}

export interface QuotaResult {
    email: string;
    isPaidAccount: boolean;
    claudeRemaining: number;
    claudeResetTime: string | null;
    claudeResetTimeRaw: string | null;  // 원본 ISO 시간 (실시간 비교용)
    geminiProRemaining: number;
    geminiFlashRemaining: number;
    models: ModelQuota[];
    lastUpdated: Date;
    error?: string;
}

// 그룹 정의
const GROUPS = {
    'Claude/GPT': ['claude', 'gpt'],
    'Gemini Pro': ['gemini-3-pro', 'gemini-2.5-pro'],
    'Gemini Flash': ['flash']
};

export class QuotaService {
    private readonly API_BASE = 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal';

    // 로컬 LS 프로세스 캐시
    private cachedLsPort: number | null = null;
    private cachedLsCsrf: string | null = null;
    private lsCacheExpiry = 0;

    /**
     * 로컬 LS API로 활성 계정 쿼터 조회 (OAuth 토큰 불필요)
     * 성공 시 QuotaResult, 실패 시 null → Google API fallback
     */
    async fetchQuotaLocal(email: string): Promise<QuotaResult | null> {
        try {
            // LS 프로세스 캐시 (60초)
            if (!this.cachedLsPort || Date.now() > this.lsCacheExpiry) {
                const info = await this.findLsProcess();
                if (!info) {
                    console.log('ReRevolve: LS 프로세스 미감지 → Google API fallback');
                    return null;
                }
                this.cachedLsPort = info.port;
                this.cachedLsCsrf = info.csrf;
                this.lsCacheExpiry = Date.now() + 60000;
            }

            const data = await this.callLocalApi(
                this.cachedLsPort!,
                this.cachedLsCsrf!,
                '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }
            );
            return this.parseLocalResponse(email, data);
        } catch (err) {
            console.log(`ReRevolve: 로컬 LS 쿼터 조회 실패: ${err} → fallback`);
            this.cachedLsPort = null;
            this.lsCacheExpiry = 0;
            return null;
        }
    }

    /** LS 캐시 무효화 (계정 전환 감지 시) */
    invalidateLsCache(): void {
        this.cachedLsPort = null;
        this.cachedLsCsrf = null;
        this.lsCacheExpiry = 0;
    }

    /**
     * 특정 토큰으로 쿼터 조회
     */
    async fetchQuota(email: string, token: string): Promise<QuotaResult> {
        try {
            // 1. 세션 활성화 시도 (loadCodeAssist) - 실패해도 계속 진행
            console.log(`ReRevolve: [${email}] 세션 활성화 시도...`);
            const sessionResult = await this.activateSession(token);
            
            // 세션 활성화 결과 로그 (실패해도 계속 진행)
            if (sessionResult.success) {
                console.log(`ReRevolve: [${email}] 세션 활성화 성공 (유료: ${sessionResult.isPaid})`);
            } else {
                console.log(`ReRevolve: [${email}] 세션 활성화 실패: ${sessionResult.error} - 쿼터 조회는 계속 시도`);
            }
            
            // 2. 쿼터 조회 전 500ms 대기 (Rate limit 방지)
            await this.delay(500);

            // 3. 모델 쿼터 가져오기 (세션 활성화와 무관하게 시도)
            const response = await fetch(`${this.API_BASE}:fetchAvailableModels`, {
                method: 'POST',
                headers: this.getHeaders(token),
                body: JSON.stringify({})
            });

            if (response.status === 401) {
                return this.createErrorResult(email, '토큰 만료됨');
            }

            if (!response.ok) {
                return this.createErrorResult(email, `API 오류: ${response.status}`);
            }

            const data = await response.json() as any;
            return this.parseQuotaResponse(email, data, sessionResult.isPaid);
        } catch (err) {
            console.error('ReRevolve: Fetch quota failed', err);
            return this.createErrorResult(email, String(err));
        }
    }

    /**
     * 세션 활성화 (loadCodeAssist)
     * 이 API를 호출해야 해당 토큰이 "활성 세션"으로 등록됨
     */
    private async activateSession(token: string): Promise<{ success: boolean; isPaid: boolean; error?: string }> {
        try {
            const response = await fetch(`${this.API_BASE}:loadCodeAssist`, {
                method: 'POST',
                headers: this.getHeaders(token),
                body: JSON.stringify({
                    metadata: {
                        ideType: 'ANTIGRAVITY',
                        platform: 'PLATFORM_UNSPECIFIED',
                        pluginType: 'GEMINI'
                    }
                })
            });

            if (response.status === 401) {
                return { success: false, isPaid: false, error: '토큰 만료됨' };
            }

            if (!response.ok) {
                return { success: false, isPaid: false, error: `세션 API 오류: ${response.status}` };
            }

            const data = await response.json() as any;
            const isPaid = 'paidTier' in data && data.paidTier !== undefined;
            
            return { success: true, isPaid };
        } catch (err) {
            return { success: false, isPaid: false, error: String(err) };
        }
    }

    /**
     * 딜레이 함수 (Rate limit 방지)
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private getHeaders(token: string): Record<string, string> {
        return {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/1.11.5 windows/amd64',
            'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
            'Client-Metadata': JSON.stringify({
                ideType: 'IDE_UNSPECIFIED',
                platform: 'PLATFORM_UNSPECIFIED',
                pluginType: 'GEMINI'
            })
        };
    }

    private parseQuotaResponse(email: string, data: any, isPaidAccount: boolean): QuotaResult {
        const models: ModelQuota[] = [];

        // 2차 검증: paidTier가 없더라도 quotaLimit이 있으면 유료 계정으로 간주
        if (!isPaidAccount && data.models) {
            for (const model of Object.values(data.models) as any[]) {
                if (model?.quotaInfo?.quotaLimit !== undefined) {
                    isPaidAccount = true;
                    break;
                }
            }
        }

        if (data.models) {
            for (const [key, model] of Object.entries(data.models) as any) {
                const displayName = model.displayName || key;
                let remaining = 0;
                if (model.quotaInfo) {
                    remaining = typeof model.quotaInfo.remainingFraction === 'number'
                        ? Math.round(model.quotaInfo.remainingFraction * 100)
                        : 0;
                }
                const resetTime = model.quotaInfo?.resetTime || null;

                models.push({
                    displayName,
                    model: model.model || key,
                    remainingPercentage: remaining,
                    resetTime
                });
            }
        }

        // 그룹별 최소 쿼터 계산
        const groupStats = this.calculateGroupStats(models);

        // Claude/GPT 그룹 값
        const claudeGroup = groupStats['Claude/GPT'];
        let claudeRemaining = 0;
        let claudeResetTime: string | null = null;

        if (claudeGroup) {
            claudeRemaining = claudeGroup.min;
            claudeResetTime = claudeGroup.reset;
        } else if (models.length > 0) {
            // 폴백: 전체 최소값
            const lowest = models.reduce((min, curr) => 
                curr.remainingPercentage < min.remainingPercentage ? curr : min
            );
            claudeRemaining = lowest.remainingPercentage;
            claudeResetTime = lowest.resetTime;
        }

        return {
            email,
            isPaidAccount,
            claudeRemaining,
            claudeResetTime: this.formatResetTime(claudeResetTime),
            claudeResetTimeRaw: claudeResetTime,  // 원본 ISO 시간 보관
            geminiProRemaining: groupStats['Gemini Pro']?.min ?? 100,
            geminiFlashRemaining: groupStats['Gemini Flash']?.min ?? 100,
            models,
            lastUpdated: new Date()
        };
    }

    private calculateGroupStats(models: ModelQuota[]): Record<string, { min: number; reset: string | null }> {
        const stats: Record<string, { min: number; reset: string | null }> = {};

        for (const [groupName, keywords] of Object.entries(GROUPS)) {
            const groupModels = models.filter(m =>
                keywords.some(k => 
                    m.model.toLowerCase().includes(k) || 
                    m.displayName.toLowerCase().includes(k)
                )
            );

            if (groupModels.length > 0) {
                const lowest = groupModels.reduce((min, curr) =>
                    curr.remainingPercentage < min.remainingPercentage ? curr : min
                );
                stats[groupName] = {
                    min: lowest.remainingPercentage,
                    reset: lowest.resetTime
                };
            }
        }

        return stats;
    }

    private formatResetTime(resetTimeStr: string | null): string | null {
        if (!resetTimeStr) return null;

        try {
            const resetTime = new Date(resetTimeStr);
            const now = new Date();
            const diff = resetTime.getTime() - now.getTime();

            if (diff <= 0) return '준비됨';

            const minutes = Math.ceil(diff / 60000);
            if (minutes < 60) return `${minutes}분`;

            const hours = Math.floor(minutes / 60);
            if (hours < 24) return `${hours}시간 ${minutes % 60}분`;

            const days = Math.floor(hours / 24);
            return `${days}일 ${hours % 24}시간`;
        } catch {
            return resetTimeStr;
        }
    }

    private createErrorResult(email: string, error: string): QuotaResult {
        return {
            email,
            isPaidAccount: false,
            claudeRemaining: -1,
            claudeResetTime: null,
            claudeResetTimeRaw: null,
            geminiProRemaining: -1,
            geminiFlashRemaining: -1,
            models: [],
            lastUpdated: new Date(),
            error
        };
    }

    // ========== 로컬 LS 응답 파싱 ==========

    private parseLocalResponse(email: string, data: any): QuotaResult {
        const models: ModelQuota[] = [];
        const userStatus = data?.userStatus;
        const rawModels: any[] = userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
        const planStatus = userStatus?.planStatus;
        const isPaidAccount = !!(planStatus?.planInfo?.monthlyPromptCredits > 0);

        for (const m of rawModels) {
            if (!m.quotaInfo) continue;
            models.push({
                displayName: m.label || 'Unknown',
                model: m.modelOrAlias?.model || 'unknown',
                remainingPercentage: Math.round((m.quotaInfo.remainingFraction ?? 0) * 100),
                resetTime: m.quotaInfo.resetTime || null
            });
        }

        const groupStats = this.calculateGroupStats(models);
        const claudeGroup = groupStats['Claude/GPT'];
        let claudeRemaining = 0;
        let claudeResetTime: string | null = null;

        if (claudeGroup) {
            claudeRemaining = claudeGroup.min;
            claudeResetTime = claudeGroup.reset;
        } else if (models.length > 0) {
            const lowest = models.reduce((min, curr) =>
                curr.remainingPercentage < min.remainingPercentage ? curr : min
            );
            claudeRemaining = lowest.remainingPercentage;
            claudeResetTime = lowest.resetTime;
        }

        console.log(`ReRevolve: [${email}] 로컬 LS 쿼터 조회 성공 (${models.length}개 모델)`);

        return {
            email,
            isPaidAccount,
            claudeRemaining,
            claudeResetTime: this.formatResetTime(claudeResetTime),
            claudeResetTimeRaw: claudeResetTime,
            geminiProRemaining: groupStats['Gemini Pro']?.min ?? 100,
            geminiFlashRemaining: groupStats['Gemini Flash']?.min ?? 100,
            models,
            lastUpdated: new Date()
        };
    }

    // ========== LS 프로세스 탐지 ==========

    private async findLsProcess(): Promise<{ port: number; csrf: string } | null> {
        try {
            const name = process.platform === 'win32' ? 'language_server_windows_x64.exe'
                : process.platform === 'darwin' ? `language_server_macos${process.arch === 'arm64' ? '_arm' : ''}`
                : `language_server_linux${process.arch === 'arm64' ? '_arm' : '_x64'}`;

            let pid: number;
            let csrf: string;

            if (process.platform === 'win32') {
                const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='${name}'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"`;
                const { stdout } = await execAsync(cmd, { timeout: 5000 });
                let data = JSON.parse(stdout.trim());
                if (Array.isArray(data)) {
                    data = data.filter((d: any) => {
                        const c = (d.CommandLine || '').toLowerCase();
                        return c.includes('\\antigravity\\') || c.includes('/antigravity/');
                    });
                    if (data.length === 0) return null;
                    data = data[0];
                }
                const cmdLine = data.CommandLine || '';
                pid = data.ProcessId;
                const tokenMatch = cmdLine.match(/--csrf_token[=\s]+([a-f0-9\-]+)/i);
                if (!pid || !tokenMatch?.[1]) return null;
                csrf = tokenMatch[1];
            } else {
                const cmd = process.platform === 'darwin' ? `pgrep -fl ${name}` : `pgrep -af ${name}`;
                const { stdout } = await execAsync(cmd, { timeout: 5000 });
                const line = stdout.split('\n').find(l => l.includes('--csrf_token'));
                if (!line) return null;
                const parts = line.trim().split(/\s+/);
                pid = parseInt(parts[0], 10);
                const tokenMatch = line.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);
                csrf = tokenMatch ? tokenMatch[1] : '';
            }

            if (!csrf) return null;

            // 리스닝 포트 찾기
            const ports = await this.getListeningPorts(pid);
            for (const port of ports) {
                const ok = await this.testLsPort(port, csrf);
                if (ok) return { port, csrf };
            }
            return null;
        } catch {
            return null;
        }
    }

    private async getListeningPorts(pid: number): Promise<number[]> {
        try {
            let cmd: string;
            if (process.platform === 'win32') {
                cmd = `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort | ConvertTo-Json"`;
            } else if (process.platform === 'darwin') {
                cmd = `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`;
            } else {
                cmd = `ss -tlnp 2>/dev/null | grep "pid=${pid}"`;
            }
            const { stdout } = await execAsync(cmd, { timeout: 5000 });

            const ports: number[] = [];
            if (process.platform === 'win32') {
                try {
                    const data = JSON.parse(stdout.trim());
                    const arr = Array.isArray(data) ? data : [data];
                    for (const p of arr) {
                        if (typeof p === 'number') ports.push(p);
                    }
                } catch { /* ignore */ }
            } else {
                for (const line of stdout.split('\n')) {
                    const m = line.match(/:(\d+)\s/);
                    if (m) ports.push(parseInt(m[1], 10));
                }
            }
            return ports;
        } catch {
            return [];
        }
    }

    private testLsPort(port: number, csrf: string): Promise<boolean> {
        return new Promise(resolve => {
            const req = http.request(
                {
                    hostname: '127.0.0.1',
                    port,
                    path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Codeium-Csrf-Token': csrf,
                        'Connect-Protocol-Version': '1',
                    },
                    timeout: 3000,
                },
                res => {
                    let body = '';
                    res.on('data', (c: Buffer) => (body += c));
                    res.on('end', () => {
                        resolve(res.statusCode === 200);
                    });
                }
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.write(JSON.stringify({ wrapper_data: {} }));
            req.end();
        });
    }

    private callLocalApi(port: number, csrf: string, path: string, body: object): Promise<any> {
        return new Promise((resolve, reject) => {
            const payload = JSON.stringify(body);
            const req = http.request(
                {
                    hostname: '127.0.0.1',
                    port,
                    path,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                        'Connect-Protocol-Version': '1',
                        'X-Codeium-Csrf-Token': csrf,
                    },
                    timeout: 5000,
                },
                res => {
                    let raw = '';
                    res.on('data', (c: Buffer) => (raw += c));
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 400) {
                            reject(new Error(`HTTP ${res.statusCode}`));
                            return;
                        }
                        try { resolve(JSON.parse(raw)); }
                        catch { reject(new Error('Invalid JSON')); }
                    });
                }
            );
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(payload);
            req.end();
        });
    }
}
