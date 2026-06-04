/**
 * ReRevolve - Antigravity 다중 계정 쿼터 관리 확장프로그램
 * 진입점  
 */

import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar-provider';
import { AccountManager } from './account-manager';
import { TokenService } from './token-service';
import { QuotaService, QuotaResult } from './quota-service';
import { AutoAcceptService } from './auto-accept-service';
import { PrewarmService } from './prewarm-service';
import { AccountSwitcher } from './account-switcher';
import { LanguageServerClient } from './language-server-client';

let sidebarProvider: SidebarProvider;
let autoAcceptService: AutoAcceptService;
let statusBarItem: vscode.StatusBarItem;
let retryStatusBarItem: vscode.StatusBarItem;
let quotaStatusBarItem: vscode.StatusBarItem;
let tokenService: TokenService;
let quotaService: QuotaService;
let accountManager: AccountManager;
let accountSwitcher: AccountSwitcher;
let prewarmService: PrewarmService;

/**
 * Status Bar 아이템 상태 업데이트 (Auto-Accept)
 */
function updateStatusBarItem(enabled: boolean, cdp: boolean = false, retryEnabled: boolean = false): void {
    const cdpLabel = cdp ? ' (CDP)' : '';

    if (enabled) {
        statusBarItem.text = `$(rocket) Accept ON${cdpLabel}`;
        statusBarItem.tooltip = `ReRevolve Auto-Accept ON${cdpLabel}\nAccept/Run/Permission 수락 자동화\n클릭하여 끄기 (Ctrl+Alt+Shift+A)`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    } else {
        statusBarItem.text = '$(debug-stop) Accept OFF';
        statusBarItem.tooltip = 'ReRevolve Auto-Accept OFF\n클릭하여 켜기 (Ctrl+Alt+Shift+A)';
        statusBarItem.backgroundColor = undefined;
    }

    if (!retryStatusBarItem) return;

    if (retryEnabled) {
        retryStatusBarItem.text = `$(debug-restart) Retry ON${cdpLabel}`;
        retryStatusBarItem.tooltip = `ReRevolve Auto-Retry ON${cdpLabel}\nRetry/Continue 복구 자동화\n클릭하여 끄기 (Ctrl+Alt+Shift+R)`;
        retryStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    } else {
        retryStatusBarItem.text = '$(debug-restart) Retry OFF';
        retryStatusBarItem.tooltip = 'ReRevolve Auto-Retry OFF\nRetry/Continue 복구 자동화가 꺼져 있습니다\n클릭하여 켜기 (Ctrl+Alt+Shift+R)';
        retryStatusBarItem.backgroundColor = undefined;
    }
}

/**
 * 쿼터에 따른 달 모양 이모지 반환
 */
function getMoonPhase(percent: number): string {
    if (percent >= 80) return '🌕'; // 만월 (가득)
    if (percent >= 60) return '🌔'; // 상현달
    if (percent >= 40) return '🌓'; // 반달
    if (percent >= 20) return '🌒'; // 초승달
    return '🌑'; // 신월 (비어있음)
}

/**
 * 쿼터 상태바 업데이트 (활성 계정 Claude 쿼터) - 달 모양 스타일
 */
let lastQuotaResult: QuotaResult | null = null;  // 마지막 쿼터 결과 저장 (재충전 감지용)
let lastQuotaEmail: string | null = null;
let rechargeNotified = false;  // 충전 완료 예상 알림 중복 방지
function updateQuotaStatusBar(email: string | null, quota: QuotaResult | null): void {
    if (!email || !quota) {
        quotaStatusBarItem.text = '🌑 Claude: --';
        quotaStatusBarItem.tooltip = '활성 계정 없음\n클릭하여 쿼터 새로고침';
        quotaStatusBarItem.backgroundColor = undefined;
        return;
    }

    // 쿼터 결과 저장 (재충전 감지용)
    lastQuotaResult = quota;
    lastQuotaEmail = email;
    rechargeNotified = false;  // 새 쿼터 조회 시 알림 상태 초기화
    // -1은 쿼터 조회 실패 시 표시, 이 경우 '--'로 표시
    const percent = quota.claudeRemaining < 0 ? -1 : Math.round(quota.claudeRemaining);
    const shortEmail = email.split('@')[0];

    if (percent < 0) {
        quotaStatusBarItem.text = `🔄 ${shortEmail}: --`;
        quotaStatusBarItem.tooltip = `${email}\n쿼터 조회 실패 또는 로딩 중\n클릭하여 새로고침`;
        quotaStatusBarItem.backgroundColor = undefined;
        return;
    }

    const moon = getMoonPhase(percent);

    // 색상 결정 (20% 이하: 경고, 50% 이하: 주의)
    if (percent <= 20) {
        quotaStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (percent <= 50) {
        quotaStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        quotaStatusBarItem.backgroundColor = undefined;
    }

    const geminiPercent = quota.geminiProRemaining < 0 ? -1 : Math.round(quota.geminiProRemaining);
    const geminiPart = geminiPercent >= 0 ? ` 🔵${geminiPercent}%` : '';

    const creditPart = quota.isCreditOverage ? ' 💳' : '';
    const creditLine = quota.isCreditOverage ? '\n💳 AI 크레딧 사용 중' : '';

    quotaStatusBarItem.text = `${moon} ${shortEmail} 🟣${percent}%${creditPart}${geminiPart}`;
    quotaStatusBarItem.tooltip = `${email}\n🟣 Claude: ${percent}%${creditLine}\n🔵 Gemini Pro: ${geminiPercent >= 0 ? geminiPercent + '%' : '정보 없음'}\n⏰ 리셋: ${quota.claudeResetTime || '정보 없음'}\n클릭하여 새로고침`;
}

/**
 * 재충전 예정시간 로컬 체크 (API 호출 없이 시간 비교만)
 * 리셋 시간이 지났으면 상태바에 '충전 완료 예상' 표시
 */
function checkRechargeLocal(): void {
    if (!lastQuotaResult || !lastQuotaEmail || rechargeNotified) return;
    if (!lastQuotaResult.claudeResetTimeRaw) return;
    if (lastQuotaResult.claudeRemaining > 50) return;  // 충분하면 체크 불필요

    try {
        const resetTime = new Date(lastQuotaResult.claudeResetTimeRaw).getTime();
        if (Date.now() > resetTime) {
            // 리셋 시간이 지났음 → 충전 완료 예상 표시
            const shortEmail = lastQuotaEmail.split('@')[0];
            quotaStatusBarItem.text = `🔄 ${shortEmail}: 충전됨`;
            quotaStatusBarItem.tooltip = `${lastQuotaEmail}\n재충전 예정시간이 지났습니다\n클릭하여 실제 쿼터 확인`;
            quotaStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            rechargeNotified = true;  // 중복 알림 방지
            console.log(`ReRevolve: ${lastQuotaEmail} 충전 완료 예상 (리셋시간 경과)`);
        }
    } catch {
        // 날짜 파싱 실패 무시
    }
}

export function activate(context: vscode.ExtensionContext) {
    try {
    console.log('ReRevolve v8.2: 확장 활성화 시작');

    // 서비스 초기화
    const lsClient = new LanguageServerClient();
    accountManager = new AccountManager(context);
    tokenService = new TokenService(context.globalState, lsClient);
    quotaService = new QuotaService();
    autoAcceptService = new AutoAcceptService(context.globalState);
    accountSwitcher = new AccountSwitcher(context, tokenService);
    prewarmService = new PrewarmService(context.globalState, accountManager, tokenService, quotaService);

    // LanguageServerClient를 QuotaService에 주입 (PowerShell 중복 호출 방지)
    quotaService.setLsClient(lsClient);

    // Status Bar 아이템 생성 (우측 우선순위 높게 배치)
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        1000 // 높은 우선순위로 오른쪽에 배치
    );
    statusBarItem.command = 'rerevolve.toggleAutoAccept';

    retryStatusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        1001
    );
    retryStatusBarItem.command = 'rerevolve.toggleAutoRetry';

    updateStatusBarItem(false, false, false);
    statusBarItem.show();
    retryStatusBarItem.show();
    context.subscriptions.push(statusBarItem);
    context.subscriptions.push(retryStatusBarItem);

    // 쿼터 상태바 아이템 생성 (Auto-Accept 왼쪽에 배치)
    quotaStatusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        999 // Auto-Accept 바로 왼쪽
    );
    quotaStatusBarItem.command = 'rerevolve.refreshQuota';
    updateQuotaStatusBar(null, null);
    quotaStatusBarItem.show();
    context.subscriptions.push(quotaStatusBarItem);

    // Auto-Accept 상태 변경 시 StatusBar 업데이트 (설정 연동은 서비스 내부에서 처리)
    autoAcceptService.onStatusChange(({ enabled, retryEnabled, cdp }) => {
        updateStatusBarItem(enabled, cdp, retryEnabled);
        // 사이드바에도 상태 전달
        if (sidebarProvider) {
            sidebarProvider.updateAutoAcceptStatus(enabled);
            sidebarProvider.updateAutoRetryStatus(retryEnabled);
        }
    });

    // 사이드바 등록
    sidebarProvider = new SidebarProvider(
        context.extensionUri,
        accountManager,
        tokenService,
        quotaService,
        autoAcceptService,
        accountSwitcher,
        prewarmService
    );

    // 프리워밍 ↔ 사이드바 콜백 연결 (스마트 필터링 + 캐시 동기화)
    sidebarProvider.wirePrewarmCallbacks();

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            'rerevolve.quotaPanel',
            sidebarProvider
        )
    );

    // 명령어 등록
    context.subscriptions.push(
        vscode.commands.registerCommand('rerevolve.refreshAll', async () => {
            await sidebarProvider.refreshAll();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('rerevolve.addAccount', async () => {
            await sidebarProvider.showAddAccountDialog();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('rerevolve.captureToken', async () => {
            const email = await vscode.window.showInputBox({
                prompt: '토큰을 캡처할 이메일 주소 입력',
                placeHolder: 'example@gmail.com'
            });
            if (email) {
                await tokenService.captureCurrentToken(email);
                sidebarProvider.refresh();
            }
        })
    );

    // Auto-Accept 토글 명령어 (Ctrl+Alt+Shift+A)
    context.subscriptions.push(
        vscode.commands.registerCommand('rerevolve.toggleAutoAccept', () => {
            autoAcceptService.toggle();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('rerevolve.toggleAutoRetry', () => {
            autoAcceptService.toggleRetry();
        })
    );

    // Auto-Run 패치 되돌리기
    context.subscriptions.push(
        vscode.commands.registerCommand('rerevolve.revertAutoRun', () => {
            const { revertAll } = require('./auto-run-patcher');
            const results = revertAll();
            for (const r of results) {
                if (r.status === 'reverted') {
                    vscode.window.showInformationMessage(`ReRevolve: [${r.label}] Auto-Run 패치 복원됨`);
                } else if (r.status === 'no-backup') {
                    vscode.window.showWarningMessage(`ReRevolve: [${r.label}] 백업 파일 없음`);
                } else if (r.status === 'error') {
                    vscode.window.showErrorMessage(`ReRevolve: [${r.label}] 복원 실패: ${r.error}`);
                }
            }
            if (results.some((r: any) => r.status === 'reverted')) {
                vscode.window.showInformationMessage('패치 복원 후 Antigravity를 재시작해주세요.', '재시작').then(sel => {
                    if (sel === '재시작') vscode.commands.executeCommand('workbench.action.reloadWindow');
                });
            }
        })
    );

    // Auto-Run 패치 상태 확인
    context.subscriptions.push(
        vscode.commands.registerCommand('rerevolve.autoRunStatus', () => {
            const { getStatus } = require('./auto-run-patcher');
            const statuses = getStatus();
            const lines = statuses.map((s: any) => `[${s.label}] ${s.status}`);
            vscode.window.showInformationMessage(`Auto-Run 패치 상태: ${lines.join(', ')}`);
        })
    );

    // Antigravity 재시작 명령어 (번개 아이콘)
    context.subscriptions.push(
        vscode.commands.registerCommand('rerevolve.reloadAntigravity', async () => {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        })
    );

    // 쿼터 새로고침 명령어 (상태바 클릭 시)
    context.subscriptions.push(
        vscode.commands.registerCommand('rerevolve.refreshQuota', async () => {
            await refreshActiveQuota();
        })
    );

    // 스냅샷 저장 명령어
    context.subscriptions.push(
        vscode.commands.registerCommand('rerevolve.saveSnapshot', async () => {
            await accountSwitcher.saveSnapshot();
        })
    );

    // 계정 전환 명령어
    context.subscriptions.push(
        vscode.commands.registerCommand('rerevolve.switchAccount', async () => {
            const snapshots = await accountSwitcher.getSnapshots();
            const emails = Object.keys(snapshots);
            if (emails.length === 0) {
                vscode.window.showWarningMessage('저장된 스냅샷이 없습니다. 먼저 스냅샷을 저장하세요.');
                return;
            }
            const selected = await vscode.window.showQuickPick(emails, {
                placeHolder: '전환할 계정 선택'
            });
            if (selected) {
                await accountSwitcher.switchToAccount(selected);
            }
        })
    );

    // 활성 계정 쿼터 갱신 함수 (캐시 우선 → API fallback)
    // 이전 활성 이메일 (변경 감지용)
    let lastActiveEmail: string | null = null;

    async function refreshActiveQuota(): Promise<void> {
        try {
            const currentActive = accountManager.getAccounts().find(a => a.isActive)?.email;
            const activeEmail = await tokenService.getCurrentLoggedInEmail(currentActive);
            if (!activeEmail) {
                updateQuotaStatusBar(null, null);
                return;
            }

            // 계정 변경 감지 → 캐시 무시하고 강제 갱신
            const emailChanged = lastActiveEmail !== null && lastActiveEmail !== activeEmail;
            if (emailChanged) {
                console.log(`ReRevolve: 활성 계정 변경 감지 (${lastActiveEmail} → ${activeEmail})`);
                quotaService.invalidateLsCache();
            }
            lastActiveEmail = activeEmail;

            // 계정 변경이 아니면 캐시 우선
            if (!emailChanged) {
                const cachedQuota = sidebarProvider.getCachedQuota(activeEmail);
                if (cachedQuota && !cachedQuota.error) {
                    updateQuotaStatusBar(activeEmail, cachedQuota);
                    return;
                }
            }

            // 1차: 로컬 LS API (빠르고 부하 없음)
            const localQuota = await quotaService.fetchQuotaLocal(activeEmail);
            if (localQuota) {
                updateQuotaStatusBar(activeEmail, localQuota);
                return;
            }

            // 2차: 기존 Google API (fallback)
            const token = await tokenService.getToken(activeEmail);
            if (!token) {
                updateQuotaStatusBar(activeEmail, null);
                return;
            }

            const quota = await quotaService.fetchQuota(activeEmail, token);
            updateQuotaStatusBar(activeEmail, quota);
        } catch (err) {
            console.error('ReRevolve: 쿼터 갱신 실패', err);
            updateQuotaStatusBar(null, null);
        }
    }

    console.log('ReRevolve: 초기화 완료');

    // 즉시 활성 계정 동기화 (시작 시 이전 세션 캐시 제거)
    sidebarProvider.refreshActiveOnly().catch(() => {});

    // 상태바 빠른 갱신 (1초 후 - vscdb 빠른 경로 활용)
    setTimeout(async () => {
        console.log('ReRevolve: 시작 시 상태바 쿼터 빠른 갱신 (vscdb 경로)');
        await refreshActiveQuota();
    }, 1000);

    // 전체 갱신은 5초 후 (LS 준비 시간 확보)
    setTimeout(async () => {
        console.log('ReRevolve: 시작 시 전체 갱신 실행 (LS 경로)');
        await sidebarProvider.refreshActiveOnly();
        await sidebarProvider.refreshAll();
        await refreshActiveQuota();
    }, 5000);

    // 스마트 폴링: 창 포커스 시에만 15초마다 갱신, 비활성 시 정지
    let quotaPollingTimer: ReturnType<typeof setInterval> | null = null;

    function startQuotaPolling() {
        if (quotaPollingTimer) clearInterval(quotaPollingTimer);
        quotaPollingTimer = setInterval(async () => {
            await refreshActiveQuota();
        }, 15000);
    }

    function stopQuotaPolling() {
        if (quotaPollingTimer) {
            clearInterval(quotaPollingTimer);
            quotaPollingTimer = null;
        }
    }

    startQuotaPolling();

    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(state => {
            if (state.focused) {
                refreshActiveQuota();
                startQuotaPolling();
            } else {
                stopQuotaPolling();
            }
        })
    );

    // 재충전 로컬 체크 5초마다 (API 호출 없이 시간 비교만)
    setInterval(() => {
        checkRechargeLocal();
    }, 5000);

    // state.vscdb 파일 변경 감시 → 계정 전환 감지 (3초 debounce)
    try {
        const dbPath = tokenService.getStateDbPath();
        const fs = require('fs');
        if (fs.existsSync(dbPath)) {
            let debounceTimer: NodeJS.Timeout | null = null;
            const watcher = fs.watch(dbPath, () => {
                // 3초 debounce (PowerShell 폭증 방지)
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(async () => {
                    console.log('ReRevolve: state.vscdb 변경 감지 → 계정 재감지');
                    tokenService.invalidateCache();
                    quotaService.invalidateLsCache();
                    await sidebarProvider.refreshActiveOnly();
                    await refreshActiveQuota();
                }, 3000);
            });
            context.subscriptions.push({ dispose: () => watcher.close() });
            console.log('ReRevolve: state.vscdb 파일 감시 시작 (3s debounce)');
        }
    } catch (err) {
        console.error('ReRevolve: state.vscdb 감시 실패', err);
    }

    // antigravity_auth 세션 변경 감지 → 계정 전환 즉시 감지 (Settings Account 탭과 동일 소스)
    try {
        context.subscriptions.push(
            vscode.authentication.onDidChangeSessions(async (e) => {
                if (e.provider.id === 'antigravity_auth') {
                    console.log('ReRevolve: antigravity_auth 세션 변경 감지! → 2s 후 계정 재감지');
                    tokenService.invalidateCache();
                    quotaService.invalidateLsCache();
                    
                    // vscdb가 세션 변경을 반영할 시간을 줌 (즉시 읽으면 stale 데이터)
                    setTimeout(async () => {
                        await sidebarProvider.refreshActiveOnly();
                        await refreshActiveQuota();
                    }, 2000);
                }
            })
        );
        console.log('ReRevolve: antigravity_auth 세션 변경 감시 등록 완료');
    } catch (err) {
        console.log('ReRevolve: antigravity_auth 이벤트 등록 실패 (비 Antigravity 환경?)', err);
    }

    // Auto-Accept 저장된 상태 복원 (ON이었으면 자동 재시작)
    setTimeout(() => autoAcceptService.restoreState(), 3000);

    // Pre-warm: 시작 10초 후 자동 실행 + 4시간 주기 타이머
    setTimeout(async () => {
        const results = await prewarmService.runIfEnabled();
        if (results && results.length > 0) {
            const ok = results.filter(r => r.success && !r.skipped).length;
            const skip = results.filter(r => r.skipped).length;
            console.log(`ReRevolve Pre-warm: 시작 시 실행 완료 (성공: ${ok}, 스킵: ${skip})`);
        }
        prewarmService.scheduleTimer();
    }, 10000);
    } catch (err) {
        console.error('ReRevolve: 활성화 중 에러 발생:', err);
    }
}

export function deactivate() {
    console.log('ReRevolve: 확장 비활성화');
}
