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
import { AccountSwitcher } from './account-switcher';

let sidebarProvider: SidebarProvider;
let autoAcceptService: AutoAcceptService;
let statusBarItem: vscode.StatusBarItem;
let quotaStatusBarItem: vscode.StatusBarItem;
let tokenService: TokenService;
let quotaService: QuotaService;
let accountManager: AccountManager;
let accountSwitcher: AccountSwitcher;

/**
 * Status Bar 아이템 상태 업데이트 (Auto-Accept)
 */
function updateStatusBarItem(enabled: boolean): void {
    if (enabled) {
        statusBarItem.text = '$(rocket) Auto-Accept: ON';
        statusBarItem.tooltip = 'ReRevolve Auto-Accept 활성 상태\n클릭하여 비활성화 (Ctrl+Alt+Shift+A)';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    } else {
        statusBarItem.text = '$(debug-stop) Auto-Accept: OFF';
        statusBarItem.tooltip = 'ReRevolve Auto-Accept 비활성 상태\n클릭하여 활성화 (Ctrl+Alt+Shift+A)';
        statusBarItem.backgroundColor = undefined;
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

    quotaStatusBarItem.text = `${moon} ${shortEmail}: ${percent}%`;
    quotaStatusBarItem.tooltip = `${email}\nClaude 쿼터: ${percent}%\n리셋: ${quota.claudeResetTime || '정보 없음'}\n클릭하여 새로고침`;
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
    console.log('ReRevolve: 확장 활성화');

    // 서비스 초기화
    accountManager = new AccountManager(context);
    tokenService = new TokenService(context.globalState);
    quotaService = new QuotaService();
    autoAcceptService = new AutoAcceptService(context.globalState);
    accountSwitcher = new AccountSwitcher(context);

    // Status Bar 아이템 생성 (우측 우선순위 높게 배치)
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        1000 // 높은 우선순위로 오른쪽에 배치
    );
    statusBarItem.command = 'rerevolve.toggleAutoAccept';
    updateStatusBarItem(false);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

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
    autoAcceptService.onStatusChange((enabled) => {
        updateStatusBarItem(enabled);
    });

    // 사이드바 등록
    sidebarProvider = new SidebarProvider(
        context.extensionUri,
        accountManager,
        tokenService,
        quotaService,
        autoAcceptService,
        accountSwitcher
    );

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
    async function refreshActiveQuota(): Promise<void> {
        try {
            const activeEmail = await tokenService.getCurrentLoggedInEmail();
            if (!activeEmail) {
                updateQuotaStatusBar(null, null);
                return;
            }

            // sidebarProvider 캐시에서 우선 가져오기 (API 중복 호출 방지)
            const cachedQuota = sidebarProvider.getCachedQuota(activeEmail);
            if (cachedQuota && !cachedQuota.error) {
                updateQuotaStatusBar(activeEmail, cachedQuota);
                return;
            }

            // 캐시 없으면 직접 API 조회
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

    // 쿼터 상태바 15초마다 자동 갱신 (계정 전환 빠른 감지)
    setInterval(async () => {
        await refreshActiveQuota();
    }, 15000);

    // 재충전 로컬 체크 5초마다 (API 호출 없이 시간 비교만)
    setInterval(() => {
        checkRechargeLocal();
    }, 5000);

    // state.vscdb 파일 변경 감시 → 계정 전환 즉시 감지
    try {
        const dbPath = tokenService.getStateDbPath();
        const fs = require('fs');
        if (fs.existsSync(dbPath)) {
            let debounceTimer: NodeJS.Timeout | null = null;
            const watcher = fs.watch(dbPath, () => {
                // 파일 변경이 빠르게 여러 번 발생하므로 2초 디바운스
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(async () => {
                    console.log('ReRevolve: state.vscdb 변경 감지 → 활성 계정 재감지');
                    tokenService.invalidateCache(); // LS 캐시 무효화
                    await sidebarProvider.refreshActiveOnly();
                    await refreshActiveQuota();
                }, 2000);
            });
            context.subscriptions.push({ dispose: () => watcher.close() });
            console.log('ReRevolve: state.vscdb 파일 감시 시작');
        }
    } catch (err) {
        console.error('ReRevolve: state.vscdb 감시 실패', err);
    }

    // Auto-Accept 저장된 상태 복원 (ON이었으면 자동 재시작)
    setTimeout(() => autoAcceptService.restoreState(), 3000);
}

export function deactivate() {
    console.log('ReRevolve: 확장 비활성화');
}
