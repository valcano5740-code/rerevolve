/**
 * Quota Service - CloudCode API를 통한 쿼터 조회
 */

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
            geminiProRemaining: -1,
            geminiFlashRemaining: -1,
            models: [],
            lastUpdated: new Date(),
            error
        };
    }
}
