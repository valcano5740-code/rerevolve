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
function updateQuotaStatusBar(email: string | null, quota: QuotaResult | null): void {
    if (!email || !quota) {
        quotaStatusBarItem.text = '🌑 Claude: --';
        quotaStatusBarItem.tooltip = '활성 계정 없음\n클릭하여 쿼터 새로고침';
        quotaStatusBarItem.backgroundColor = undefined;
        return;
    }

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

export function activate(context: vscode.ExtensionContext) {
    console.log('ReRevolve: 확장 활성화');

    // 서비스 초기화
    accountManager = new AccountManager(context);
    tokenService = new TokenService(context.secrets);
    quotaService = new QuotaService();
    autoAcceptService = new AutoAcceptService();
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

    // Auto-Accept 상태 변경 시 StatusBar 업데이트
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
            const snapshots = accountSwitcher.getSnapshots();
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

    // 활성 계정 쿼터 갱신 함수
    async function refreshActiveQuota(): Promise<void> {
        try {
            const activeEmail = await tokenService.getCurrentLoggedInEmail();
            if (!activeEmail) {
                updateQuotaStatusBar(null, null);
                return;
            }

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

    // 확장프로그램 시작 시 활성 계정 감지 및 쿼터 갱신 (통합)
    setTimeout(async () => {
        console.log('ReRevolve: 시작 시 활성 계정 감지 및 쿼터 갱신');
        await sidebarProvider.refreshActiveOnly(); // 빠른 활성 계정 감지
        await refreshActiveQuota(); // 상태바도 즉시 갱신
    }, 500);

    // 전체 쿼터 갱신은 2초 후 (모든 계정)
    setTimeout(async () => {
        console.log('ReRevolve: 시작 시 전체 갱신 실행');
        await sidebarProvider.refreshAll();
        await refreshActiveQuota(); // 상태바도 갱신
    }, 2000);

    // 쿼터 상태바 60초마다 자동 갱신
    setInterval(async () => {
        await refreshActiveQuota();
    }, 60000);

    // Auto-Accept 자동 활성화: CDP 설정 확인 및 자동 시작
    setTimeout(async () => {
        console.log('ReRevolve: Auto-Accept 자동 활성화 시도');
        
        // 먼저 CDP가 이미 활성화되어 있는지 확인
        const isConnected = await autoAcceptService.tryConnect();
        
        if (isConnected) {
            console.log('ReRevolve: CDP 연결 성공! Auto-Accept 자동 시작');
            if (!autoAcceptService.isEnabled) {
                autoAcceptService.start();
                vscode.window.showInformationMessage('✅ Auto-Accept 자동 활성화됨!');
            }
        } else {
            // CDP가 없으면 바로가기에 자동으로 설정 시도 (조용히)
            console.log('ReRevolve: CDP 미연결. 바로가기 자동 설정 시도...');
            await autoAcceptService.setupCDPSilent();
        }
    }, 3000); // 3초 후 시도
}

export function deactivate() {
    console.log('ReRevolve: 확장 비활성화');
}
