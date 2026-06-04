/**
 * Pre-warm Service - 등록된 비활성 계정의 세션 사전 활성화
 * 
 * v8.3.10 개선:
 * - 스마트 필터링: 유료계정은 resetTime "5시간 0분/1분"(미활성)인 경우만 프리워밍
 * - 무료계정: refreshLocked여도 토큰이 있으면 프리워밍 대상
 * - 프리워밍 결과로 Account에 lastResetTimestamp/lastResetDurationMs 저장
 * 
 * 원리: Google CloudCode의 loadCodeAssist API를 각 계정 토큰으로 호출하면
 * 해당 계정의 세션이 활성화되어 쿼터 소모(~1토큰) → 쿨타임 카운트다운 시작
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

/** resetTime 문자열을 ms로 변환 */
function parseResetTimeToMs(resetTime: string | null | undefined): number {
    if (!resetTime) return 0;
    const dayMatch = resetTime.match(/(\d+)일/);
    const hourMatch = resetTime.match(/(\d+)시간/);
    const minuteMatch = resetTime.match(/(\d+)분/);
    const days = dayMatch ? parseInt(dayMatch[1]) : 0;
    const hours = hourMatch ? parseInt(hourMatch[1]) : 0;
    const minutes = minuteMatch ? parseInt(minuteMatch[1]) : 0;
    return (days * 24 * 60 + hours * 60 + minutes) * 60 * 1000;
}

/** resetTime이 "5시간 0분" 또는 "5시간 1분"인지 (유료 미활성 상태) */
function isUnactivatedPaidReset(resetTime: string | null | undefined): boolean {
    if (!resetTime) return true; // 정보 없으면 미활성으로 간주
    const ms = parseResetTimeToMs(resetTime);
    // 5시간 0분 (18000000ms) ~ 5시간 1분 (18060000ms) 범위
    return ms >= 5 * 60 * 60 * 1000 && ms <= 5 * 60 * 60 * 1000 + 1 * 60 * 1000;
}

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

    /** quotaCache getter (sidebar-provider에서 주입) */
    private quotaCacheGetter: (() => Record<string, QuotaResult>) | null = null;

    /** 프리워밍 결과 콜백 (sidebar-provider에서 계정/캐시 업데이트용) */
    private onPrewarmResult: ((email: string, quota: QuotaResult) => void) | null = null;

    constructor(
        private globalState: vscode.Memento,
        private accountManager: AccountManager,
        private tokenService: TokenService,
        private quotaService: QuotaService
    ) {}

    /**
     * sidebar-provider와 연동 설정
     */
    setCallbacks(
        quotaCacheGetter: () => Record<string, QuotaResult>,
        onPrewarmResult: (email: string, quota: QuotaResult) => void
    ): void {
        this.quotaCacheGetter = quotaCacheGetter;
        this.onPrewarmResult = onPrewarmResult;
    }

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
     * 
     * 스마트 필터링:
     * - 유료 비활성 계정: resetTime이 "5시간 0분/1분"(미활성) → 프리워밍
     * - 무료 비활성 계정: refreshLocked여도 토큰이 있으면 → 프리워밍
     * - 이미 카운트다운 중인 계정 → 스킵
     */
    async runPrewarm(): Promise<PrewarmResult[]> {
        if (this.running) {
            console.log('ReRevolve Pre-warm: 이미 실행 중 → 스킵');
            return [];
        }

        this.running = true;
        const results: PrewarmResult[] = [];
        const quotaCache = this.quotaCacheGetter?.() || {};

        try {
            const accounts = this.accountManager.getAccounts();
            const currentActive = accounts.find(a => a.isActive)?.email;
            const activeEmail = await this.tokenService.getCurrentLoggedInEmail(currentActive);

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

                // 캐시된 쿼터 정보로 스마트 필터링
                const cached = quotaCache[email];
                const resetTime = cached?.claudeResetTime;

                if (account.isPaid) {
                    // 유료: resetTime이 "5시간 0분/1분"이 아니면 이미 활성화됨
                    if (resetTime && !isUnactivatedPaidReset(resetTime)) {
                        results.push({
                            email,
                            success: true,
                            skipped: true,
                            skipReason: `이미 활성 (남은: ${resetTime})`
                        });
                        console.log(`ReRevolve Pre-warm: [${email}] 유료 이미 활성 (${resetTime}) → 스킵`);
                        continue;
                    }
                } else {
                    // 무료: 로컬 카운트다운이 아직 남아있으면 스킵
                    if (account.lastResetTimestamp && account.lastResetDurationMs) {
                        const elapsed = Date.now() - account.lastResetTimestamp;
                        const remaining = account.lastResetDurationMs - elapsed;
                        if (remaining > 0) {
                            const remainHours = Math.floor(remaining / 3600000);
                            results.push({
                                email,
                                success: true,
                                skipped: true,
                                skipReason: `카운트다운 중 (잔여 ${remainHours}시간)`
                            });
                            console.log(`ReRevolve Pre-warm: [${email}] 무료 카운트다운 중 (${remainHours}h) → 스킵`);
                            continue;
                        }
                    }
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

                    if (!quota.error) {
                        // 프리워밍 성공: Account에 카운트다운 기준점 저장
                        const resetMs = parseResetTimeToMs(quota.claudeResetTime);
                        if (resetMs > 0) {
                            account.lastResetTimestamp = Date.now();
                            account.lastResetDurationMs = resetMs;
                            this.accountManager.updateAccount(email, {
                                lastResetTimestamp: account.lastResetTimestamp,
                                lastResetDurationMs: account.lastResetDurationMs
                            });
                        }

                        // sidebar에 캐시 업데이트 콜백
                        this.onPrewarmResult?.(email, quota);

                        console.log(`ReRevolve Pre-warm: [${email}] ✅ 성공 (Claude: ${quota.claudeRemaining}%, 리셋: ${quota.claudeResetTime || '정보 없음'})`);
                    } else {
                        console.log(`ReRevolve Pre-warm: [${email}] ⚠️ 쿼터 조회 실패: ${quota.error}`);
                    }
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
