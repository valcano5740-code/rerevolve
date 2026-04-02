/**
 * Pre-warm Service - 등록된 모든 계정의 쿨타임을 사전 시작
 * 
 * 원리: Google CloudCode의 loadCodeAssist API를 각 계정 토큰으로 호출하면
 * 해당 계정의 세션이 활성화되어 쿼터 소모(~1토큰) → 쿨타임 카운트다운 시작
 * 
 * 참고: antigravity-usage의 "Wakeup Command", Antigravity-Manager의 "Smart Warmup"과 동일 원리
 */

import * as vscode from 'vscode';
import { AccountManager, Account } from './account-manager';
import { TokenService } from './token-service';
import { QuotaService, QuotaResult } from './quota-service';

const PREWARM_STATE_KEY = 'rerevolve.prewarmEnabled';
const PREWARM_LAST_RUN_KEY = 'rerevolve.prewarmLastRun';
const PREWARM_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4시간
const PREWARM_STARTUP_DELAY_MS = 10000; // 시작 후 10초 대기
const PREWARM_ACCOUNT_DELAY_MS = 1500; // 계정 간 1.5초 딜레이 (Rate limit 방지)

export interface PrewarmResult {
    email: string;
    success: boolean;
    claudeRemaining?: number;
    resetTime?: string | null;
    error?: string;
    skipped?: boolean;
    skipReason?: string;
}

export class PrewarmService {
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;

    constructor(
        private globalState: vscode.Memento,
        private accountManager: AccountManager,
        private tokenService: TokenService,
        private quotaService: QuotaService
    ) {}

    /**
     * Pre-warm 활성화 상태
     */
    get isEnabled(): boolean {
        return this.globalState.get<boolean>(PREWARM_STATE_KEY, false);
    }

    /**
     * Pre-warm ON/OFF 전환
     */
    async setEnabled(enabled: boolean): Promise<void> {
        await this.globalState.update(PREWARM_STATE_KEY, enabled);
        console.log(`ReRevolve Pre-warm: ${enabled ? 'ON' : 'OFF'}`);

        if (enabled) {
            this.scheduleTimer();
        } else {
            this.clearTimer();
        }
    }

    /**
     * 토글 (현재 상태 반전)
     */
    async toggle(): Promise<boolean> {
        const newState = !this.isEnabled;
        await this.setEnabled(newState);
        return newState;
    }

    /**
     * 마지막 실행 시각
     */
    get lastRunTime(): string | null {
        const val = this.globalState.get<string>(PREWARM_LAST_RUN_KEY, '');
        return val || null;
    }

    /**
     * 활성 상태일 때만 실행 (IDE 시작 시 호출용)
     */
    async runIfEnabled(): Promise<PrewarmResult[] | null> {
        if (!this.isEnabled) {
            console.log('ReRevolve Pre-warm: 비활성 상태 → 스킵');
            return null;
        }

        // 마지막 실행으로부터 3시간 이내면 스킵 (너무 잦은 트리거 방지)
        const lastRun = this.globalState.get<number>('rerevolve.prewarmLastRunTs', 0);
        const elapsed = Date.now() - lastRun;
        if (elapsed < 3 * 60 * 60 * 1000) {
            const hoursAgo = Math.round(elapsed / 3600000 * 10) / 10;
            console.log(`ReRevolve Pre-warm: 마지막 실행 ${hoursAgo}시간 전 → 3시간 미만이므로 스킵`);
            return null;
        }

        return this.runPrewarm();
    }

    /**
     * Pre-warm 즉시 실행 (수동 트리거)
     */
    async runPrewarm(): Promise<PrewarmResult[]> {
        if (this.running) {
            console.log('ReRevolve Pre-warm: 이미 실행 중 → 스킵');
            return [];
        }

        this.running = true;
        const results: PrewarmResult[] = [];

        try {
            const accounts = this.accountManager.getAccounts();
            const activeEmail = await this.tokenService.getCurrentLoggedInEmail();

            console.log(`ReRevolve Pre-warm: 시작 (${accounts.length}개 계정, 활성: ${activeEmail || '없음'})`);

            for (const account of accounts) {
                const email = account.email;

                // 활성 계정은 스킵 (이미 사용 중이므로 쿨타임 진행 중)
                if (activeEmail && email.toLowerCase() === activeEmail.toLowerCase()) {
                    results.push({
                        email,
                        success: true,
                        skipped: true,
                        skipReason: '활성 계정 (이미 사용 중)'
                    });
                    console.log(`ReRevolve Pre-warm: [${email}] 활성 계정 → 스킵`);
                    continue;
                }

                // 토큰 확인
                const hasToken = await this.tokenService.hasToken(email);
                if (!hasToken) {
                    results.push({
                        email,
                        success: false,
                        skipped: true,
                        skipReason: '토큰 없음 (OAuth 미등록)'
                    });
                    console.log(`ReRevolve Pre-warm: [${email}] 토큰 없음 → 스킵`);
                    continue;
                }

                // 토큰 획득
                const token = await this.tokenService.getToken(email);
                if (!token) {
                    results.push({
                        email,
                        success: false,
                        error: '토큰 획득 실패'
                    });
                    continue;
                }

                // 세션 활성화 + 쿼터 조회 (기존 QuotaService 활용)
                try {
                    const quota = await this.quotaService.fetchQuota(email, token);
                    results.push({
                        email,
                        success: !quota.error,
                        claudeRemaining: quota.claudeRemaining,
                        resetTime: quota.claudeResetTime,
                        error: quota.error
                    });
                    console.log(`ReRevolve Pre-warm: [${email}] ✅ 성공 (Claude: ${quota.claudeRemaining}%, 리셋: ${quota.claudeResetTime || '정보 없음'})`);
                } catch (err) {
                    results.push({
                        email,
                        success: false,
                        error: String(err)
                    });
                    console.log(`ReRevolve Pre-warm: [${email}] ❌ 실패: ${err}`);
                }

                // 계정 간 딜레이 (Rate limit 방지)
                if (accounts.indexOf(account) < accounts.length - 1) {
                    await this.delay(PREWARM_ACCOUNT_DELAY_MS);
                }
            }

            // 마지막 실행 시간 저장
            const now = new Date();
            await this.globalState.update(PREWARM_LAST_RUN_KEY, now.toISOString());
            await this.globalState.update('rerevolve.prewarmLastRunTs', Date.now());

            const successCount = results.filter(r => r.success && !r.skipped).length;
            const skipCount = results.filter(r => r.skipped).length;
            const failCount = results.filter(r => !r.success && !r.skipped).length;

            console.log(`ReRevolve Pre-warm: 완료 (성공: ${successCount}, 스킵: ${skipCount}, 실패: ${failCount})`);

        } catch (err) {
            console.error('ReRevolve Pre-warm: 치명적 오류', err);
        } finally {
            this.running = false;
        }

        return results;
    }

    /**
     * 4시간 주기 타이머 시작
     */
    scheduleTimer(): void {
        this.clearTimer();
        if (!this.isEnabled) return;

        this.timer = setInterval(async () => {
            console.log('ReRevolve Pre-warm: 주기적 실행 (4시간)');
            await this.runPrewarm();
        }, PREWARM_INTERVAL_MS);

        console.log('ReRevolve Pre-warm: 4시간 타이머 등록');
    }

    /**
     * 타이머 해제
     */
    clearTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * 현재 실행 중 여부
     */
    get isRunning(): boolean {
        return this.running;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 정리 (확장 비활성화 시)
     */
    dispose(): void {
        this.clearTimer();
    }
}
