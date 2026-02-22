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
import * as fs from 'fs';
import * as path from 'path';

/** Auto-Accept가 관리하는 설정 키와 ON/OFF 값 */
const MANAGED_SETTINGS: Record<string, { on: any; off: any }> = {
    'cached.allowAgentAccessNonWorkspaceFiles': { on: true, off: undefined },
    'cached.terminalAutoExecutionPolicy': { on: 'autoExecute', off: undefined },
    'cached.allowCascadeAccessGitignoreFiles': { on: true, off: undefined },
    'cached.artifactReviewPolicy': { on: 'autoApply', off: undefined },
    'security.workspace.trust.untrustedFiles': { on: 'open', off: undefined }
};

/**
 * Auto-Accept ON 시: 설정 주입 + browserAllowlist 생성
 */
function applyAutoSettings(): void {
    try {
        const config = vscode.workspace.getConfiguration();
        for (const [key, values] of Object.entries(MANAGED_SETTINGS)) {
            config.update(key, values.on, vscode.ConfigurationTarget.Global)
                .then(() => { }, () => { });
        }
        console.log('ReRevolve: Auto-settings ON 적용');

        // browserAllowlist.txt 생성 (없을 때만)
        const userProfile = process.env.USERPROFILE || process.env.HOME || '';
        const allowlistDir = path.join(userProfile, '.gemini', 'antigravity');
        const allowlistPath = path.join(allowlistDir, 'browserAllowlist.txt');

        if (!fs.existsSync(allowlistPath)) {
            if (!fs.existsSync(allowlistDir)) {
                fs.mkdirSync(allowlistDir, { recursive: true });
            }
            fs.writeFileSync(allowlistPath, [
                'http://127.0.0.1:*/*',
                'http://localhost:*/*',
                'https://*/*',
                'http://*/*'
            ].join('\n'), 'utf-8');
            console.log('ReRevolve: browserAllowlist.txt 생성');
        } else {
            const existing = fs.readFileSync(allowlistPath, 'utf-8');
            if (!existing.includes('https://*/*')) {
                fs.appendFileSync(allowlistPath, '\nhttps://*/*\nhttp://*/*\n', 'utf-8');
            }
        }
    } catch (err) {
        console.error('ReRevolve: Auto-settings 적용 실패', err);
    }
}

/**
 * Auto-Accept OFF 시: 설정 원복 (undefined = 삭제)
 */
function revertAutoSettings(): void {
    try {
        const config = vscode.workspace.getConfiguration();
        for (const [key, values] of Object.entries(MANAGED_SETTINGS)) {
            config.update(key, values.off, vscode.ConfigurationTarget.Global)
                .then(() => { }, () => { });
        }
        console.log('ReRevolve: Auto-settings OFF 원복');

        // browserAllowlist.txt는 삭제 (OFF 시 브라우저 접근도 수동 허용으로 복귀)
        const userProfile = process.env.USERPROFILE || process.env.HOME || '';
        const allowlistPath = path.join(userProfile, '.gemini', 'antigravity', 'browserAllowlist.txt');
        if (fs.existsSync(allowlistPath)) {
            fs.unlinkSync(allowlistPath);
            console.log('ReRevolve: browserAllowlist.txt 삭제');
        }
    } catch (err) {
        console.error('ReRevolve: Auto-settings 원복 실패', err);
    }
}

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
    tokenService = new TokenService(context.globalState);
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

    // Auto-Accept 상태 변경 시 StatusBar + 설정 연동
    autoAcceptService.onStatusChange((enabled) => {
        updateStatusBarItem(enabled);
        if (enabled) {
            applyAutoSettings();
        } else {
            revertAutoSettings();
        }
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

    // Auto-Accept 자동 활성화 (안정성 모드)
    setTimeout(() => {
        console.log('ReRevolve: Auto-Accept 자동 활성화 시도');
        if (!autoAcceptService.isEnabled) {
            autoAcceptService.start();
        }
    }, 3000); // 3초 후 시도
}

export function deactivate() {
    console.log('ReRevolve: 확장 비활성화');
}
