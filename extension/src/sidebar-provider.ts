/**
 * Sidebar Provider - Webview 기반 사이드바 UI
 */

import * as vscode from 'vscode';
import { AccountManager, Account } from './account-manager';
import { TokenService } from './token-service';
import { QuotaService, QuotaResult } from './quota-service';
import { AutoAcceptService } from './auto-accept-service';
import { AccountSwitcher } from './account-switcher';
import * as fs from 'fs';
import * as path from 'path';

interface QuotaCache {
    [email: string]: QuotaResult;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private quotaCache: QuotaCache = {};
    private quotaCachePath: string;
    private activityLogs: { time: string; message: string; type: 'info' | 'success' | 'error' }[] = [];
    private static readonly MAX_LOGS = 50;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private accountManager: AccountManager,
        private tokenService: TokenService,
        private quotaService: QuotaService,
        private autoAcceptService: AutoAcceptService,
        private accountSwitcher?: AccountSwitcher
    ) {
        // 쿼터 캐시 파일 경로
        const globalStoragePath = vscode.Uri.joinPath(extensionUri, '..', '..', '.rerevolve-cache').fsPath;
        this.quotaCachePath = path.join(globalStoragePath, 'quotas.json');
        this.loadQuotaCache();
    }

    /**
     * 활동 로그 추가 및 웹뷰로 전송
     */
    private addLog(message: string, type: 'info' | 'success' | 'error' = 'info'): void {
        const now = new Date();
        const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

        this.activityLogs.unshift({ time, message, type });

        // 최대 개수 제한
        if (this.activityLogs.length > SidebarProvider.MAX_LOGS) {
            this.activityLogs = this.activityLogs.slice(0, SidebarProvider.MAX_LOGS);
        }

        // 웹뷰로 로그 전송
        this._view?.webview.postMessage({
            command: 'updateLogs',
            logs: this.activityLogs
        });

        // 콘솔에도 출력
        console.log(`ReRevolve: ${message}`);
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        webviewView.webview.html = this.getHtmlContent();

        // 메시지 핸들러
        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'refreshAll':
                    await this.refreshAll();
                    break;
                case 'refreshActiveOnly':
                    await this.refreshActiveOnly();
                    break;
                case 'refreshAccount':
                    await this.refreshAccount(message.email);
                    break;
                case 'captureToken':
                    await this.tokenService.captureCurrentToken(message.email);
                    // 토큰 캡처 시 스냅샷도 함께 저장
                    if (this.accountSwitcher) {
                        await this.accountSwitcher.saveSnapshot();
                    }
                    this.refresh();
                    break;
                case 'addAccount':
                    await this.showAddAccountDialog();
                    break;
                case 'removeAccount':
                    const confirmDelete = await vscode.window.showWarningMessage(
                        `${message.email} 계정을 삭제하시겠습니까?`,
                        { modal: true },
                        '삭제'
                    );
                    if (confirmDelete === '삭제') {
                        this.accountManager.removeAccount(message.email);
                        await this.tokenService.deleteToken(message.email);
                        this.refresh();
                    }
                    break;
                case 'toggleTier':
                    const account = this.accountManager.getAccount(message.email);
                    if (account) {
                        const newTier = account.tier === 'free' ? 'pro' : 'free';
                        this.accountManager.updateAccount(message.email, {
                            tier: newTier,
                            isPaid: newTier !== 'free',
                            refreshLocked: newTier === 'free' && !account.isActive
                        });
                        this.refresh();
                    }
                    break;
                case 'getInitialData':
                    this.sendDataToWebview();
                    break;
                case 'clearLogs':
                    this.activityLogs = [];
                    break;
                case 'reorderAccounts':
                    this.accountManager.reorderAccounts(message.order);
                    this.refresh();
                    break;
                case 'editAccount':
                    const editAccount = this.accountManager.getAccount(message.email);
                    if (editAccount) {
                        const newName = await vscode.window.showInputBox({
                            prompt: '새 이름 입력',
                            value: editAccount.name,
                            placeHolder: editAccount.email.split('@')[0]
                        });
                        if (newName && newName !== editAccount.name) {
                            this.accountManager.updateAccount(message.email, { name: newName });
                            this.refresh();
                        }
                    }
                    break;
                case 'exportData':
                    await this.exportData();
                    break;
                case 'importData':
                    await this.importData();
                    break;
                case 'toggleAutoAccept':
                    const isEnabled = this.autoAcceptService.toggle();
                    this._view?.webview.postMessage({
                        command: 'autoAcceptStatus',
                        enabled: isEnabled
                    });
                    break;
                case 'setupCDP':
                    vscode.window.showInformationMessage('CDP 설정은 안정성 모드에서는 사용되지 않습니다.');
                    break;
                case 'removeCDP':
                    vscode.window.showInformationMessage('CDP 제거는 안정성 모드에서는 사용되지 않습니다.');
                    break;
                case 'openRules':
                    const rulesPath = path.join(process.env.USERPROFILE || '', '.gemini', 'GEMINI.md');
                    if (fs.existsSync(rulesPath)) {
                        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(rulesPath));
                    } else {
                        vscode.window.showWarningMessage('Rules 파일을 찾을 수 없습니다: ' + rulesPath);
                    }
                    break;
                case 'openMCP':
                    const mcpPath = path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity', 'mcp_config.json');
                    if (fs.existsSync(mcpPath)) {
                        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(mcpPath));
                    } else {
                        vscode.window.showWarningMessage('MCP 설정 파일을 찾을 수 없습니다: ' + mcpPath);
                    }
                    break;
                case 'openAllowlist':
                    const allowlistPath = path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity', 'browserAllowlist.txt');
                    if (fs.existsSync(allowlistPath)) {
                        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(allowlistPath));
                    } else {
                        vscode.window.showWarningMessage('Allowlist 파일을 찾을 수 없습니다: ' + allowlistPath);
                    }
                    break;
                case 'openBrain':
                    const brainPath = path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity', 'brain');
                    if (fs.existsSync(brainPath)) {
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(brainPath));
                    } else {
                        vscode.window.showWarningMessage('Brain 폴더를 찾을 수 없습니다: ' + brainPath);
                    }
                    break;
                case 'openCodeTracker':
                    const trackerPath = path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity', 'code_tracker');
                    if (fs.existsSync(trackerPath)) {
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(trackerPath));
                    } else {
                        vscode.window.showWarningMessage('Code Tracker 폴더를 찾을 수 없습니다: ' + trackerPath);
                    }
                    break;
                case 'restartService':
                    vscode.commands.executeCommand('workbench.action.restartExtensionHost');
                    break;
                case 'resetCache':
                    const cachePath = path.join(process.env.USERPROFILE || '', '.gemini', 'antigravity', 'conversations');
                    if (fs.existsSync(cachePath)) {
                        vscode.window.showInformationMessage('대화 캐시 폴더를 열었습니다.');
                        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(cachePath));
                    } else {
                        vscode.window.showInformationMessage('캐시 폴더를 찾을 수 없습니다.');
                    }
                    break;
                case 'reloadWindow':
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                    break;
                case 'showMessage':
                    vscode.window.showInformationMessage(message.text);
                    break;
                // ========== Account Switcher ==========
                case 'saveSnapshot':
                    if (this.accountSwitcher) {
                        await this.accountSwitcher.saveSnapshot();
                        this.sendDataToWebview();
                    }
                    break;
                case 'switchAccount':
                    if (this.accountSwitcher && message.email) {
                        await this.accountSwitcher.switchToAccount(message.email);
                    }
                    break;
                case 'getSnapshots':
                    if (this.accountSwitcher) {
                        const snapshots = await this.accountSwitcher.getSnapshots();
                        this._view?.webview.postMessage({
                            command: 'snapshotList',
                            snapshots: Object.keys(snapshots)
                        });
                    }
                    break;
                case 'deleteSnapshot':
                    if (this.accountSwitcher && message.email) {
                        this.accountSwitcher.deleteSnapshot(message.email);
                        this.sendDataToWebview();
                    }
                    break;
            }
        });
    }

    /**
     * 모든 데이터를 JSON 파일로 내보내기
     */
    private async exportData(): Promise<void> {
        try {
            const accounts = this.accountManager.getAccounts();
            const tokens: { [email: string]: string } = {};

            // 각 계정의 raw credential 수집 (refresh token 포함)
            for (const account of accounts) {
                const rawCredential = this.tokenService.getRawCredential(account.email);
                if (rawCredential) {
                    tokens[account.email] = rawCredential;
                }
            }

            const exportData = {
                version: '6.6.0',
                exportDate: new Date().toISOString(),
                accounts: accounts,
                tokens: tokens,
                quotaCache: this.quotaCache
            };

            const uri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file('rerevolve-backup.json'),
                filters: { 'JSON Files': ['json'] }
            });

            if (uri) {
                const fs = require('fs');
                fs.writeFileSync(uri.fsPath, JSON.stringify(exportData, null, 2));
                const tokenCount = Object.keys(tokens).length;
                vscode.window.showInformationMessage(`📤 데이터 내보내기 완료! (${accounts.length}개 계정, ${tokenCount}개 토큰)`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`내보내기 실패: ${error}`);
        }
    }

    /**
     * JSON 파일에서 데이터 가져오기
     */
    private async importData(): Promise<void> {
        try {
            const uri = await vscode.window.showOpenDialog({
                filters: { 'JSON Files': ['json'] },
                canSelectMany: false
            });

            if (!uri || uri.length === 0) return;

            const fs = require('fs');
            const content = fs.readFileSync(uri[0].fsPath, 'utf8');
            const importData = JSON.parse(content);

            // 버전 확인
            if (!importData.version || !importData.accounts) {
                vscode.window.showErrorMessage('유효하지 않은 백업 파일입니다.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `${importData.accounts.length}개의 계정을 가져오시겠습니까? 기존 데이터가 덮어쓰여집니다.`,
                '가져오기',
                '취소'
            );

            if (confirm !== '가져오기') return;

            // 계정 가져오기
            for (const account of importData.accounts) {
                this.accountManager.addAccount(account.email, account.name, account.tier);
                if (account.quota) {
                    this.quotaCache[account.email] = account.quota;
                }
            }

            // 토큰 가져오기
            if (importData.tokens) {
                for (const [email, token] of Object.entries(importData.tokens)) {
                    await this.tokenService.saveToken(email, token as string);
                }
            }

            this.saveQuotaCache();
            this.refresh();
            vscode.window.showInformationMessage(`${importData.accounts.length}개의 계정을 가져왔습니다.`);
        } catch (error) {
            vscode.window.showErrorMessage(`가져오기 실패: ${error}`);
        }
    }

    async refreshAll(): Promise<void> {
        this.addLog('🚀 전체 새로고침 시작', 'info');

        const accounts = this.accountManager.getAccounts();
        const activeCount = accounts.filter(a => !a.refreshLocked).length;
        this.addLog(`📋 ${accounts.length}개 계정 (활성: ${activeCount}개)`, 'info');

        // 현재 로그인된 이메일 감지하여 활성 계정 설정
        const currentEmail = await this.tokenService.getCurrentLoggedInEmail();
        if (currentEmail) {
            const matchingAccount = accounts.find(a => a.email.toLowerCase() === currentEmail.toLowerCase());
            if (matchingAccount) {
                this.accountManager.setActiveAccount(currentEmail);
                this.addLog(`👤 활성 계정: ${currentEmail}`, 'success');
            }
        }

        for (const account of accounts) {
            // 무료 비활성화 계정은 새로고침 잠금
            if (account.refreshLocked) {
                continue;
            }

            await this.refreshAccount(account.email);
        }

        this.saveQuotaCache();
        this.refresh();
        this.addLog('✅ 전체 새로고침 완료', 'success');
    }

    /**
     * 현재 로그인된 활성 계정만 감지하고 갱신 (30초 자동 갱신용)
     */
    async refreshActiveOnly(): Promise<void> {
        // 현재 로그인된 이메일 실시간 감지
        const currentEmail = await this.tokenService.getCurrentLoggedInEmail();
        if (!currentEmail) {
            console.log('ReRevolve: 현재 로그인된 계정을 감지할 수 없습니다.');
            return;
        }

        const accounts = this.accountManager.getAccounts();
        const matchingAccount = accounts.find(a => a.email.toLowerCase() === currentEmail.toLowerCase());

        if (matchingAccount) {
            // 활성 계정 업데이트
            this.accountManager.setActiveAccount(currentEmail);

            // 해당 계정만 갱신
            if (!matchingAccount.refreshLocked) {
                await this.refreshAccount(currentEmail);
            }
        }

        this.refresh();

        // 상태바도 즉시 갱신
        vscode.commands.executeCommand('rerevolve.refreshQuota');
    }

    async refreshAccount(email: string): Promise<void> {
        this.addLog(`🔄 ${email} 새로고침 시작`, 'info');

        const account = this.accountManager.getAccount(email);
        if (!account) {
            this.addLog(`❌ ${email} 계정 없음`, 'error');
            return;
        }

        // 무료 비활성화 계정은 새로고침 잠금
        if (account.refreshLocked) {
            this.addLog(`🔒 ${email} 새로고침 잠금`, 'info');
            return;
        }

        const token = await this.tokenService.getToken(email);
        if (!token) {
            this.addLog(`🔑 ${email} 토큰 없음`, 'error');
            return;
        }
        this.addLog(`✅ ${email} 토큰 획득`, 'success');

        const quota = await this.quotaService.fetchQuota(email, token);

        if (quota.error) {
            this.addLog(`⚠️ ${email}: ${quota.error}`, 'error');
        } else {
            this.addLog(`📊 ${email}: Claude ${quota.claudeRemaining}%`, 'success');
        }

        // 쿼터 조회 실패 시 이전 캐시 값 유지 (에러가 있고 값이 무효한 경우)
        if (quota.error && quota.claudeRemaining < 0) {
            const oldQuota = this.quotaCache[email];
            if (oldQuota && !oldQuota.error) {
                this.addLog(`💾 ${email} 이전 값 유지: ${oldQuota.claudeRemaining}%`, 'info');
                // 타임스탬프만 업데이트
                oldQuota.lastUpdated = new Date();
                return;
            }
        }

        this.quotaCache[email] = quota;

        // 참고: tier는 사용자가 설정한 값 유지 (API 응답으로 자동 변경하지 않음)
        // refreshLocked도 사용자/시스템이 명시적으로 설정한 경우에만 적용

        this.saveQuotaCache();
        this.refresh();
    }

    async showAddAccountDialog(): Promise<void> {
        const email = await vscode.window.showInputBox({
            prompt: '계정 이메일 주소',
            placeHolder: 'example@gmail.com',
            validateInput: (value) => {
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!value) return '이메일을 입력하세요';
                if (!emailRegex.test(value)) return '올바른 이메일 형식이 아닙니다';
                return null;
            }
        });

        if (!email) return;

        const name = await vscode.window.showInputBox({
            prompt: '계정 별칭 (선택사항)',
            placeHolder: email.split('@')[0]
        }) || email.split('@')[0];

        const tierPick = await vscode.window.showQuickPick(
            [
                { label: '무료 (Free)', value: 'free' },
                { label: '유료 (Pro)', value: 'pro' },
                { label: '울트라 (Ultra)', value: 'ultra' }
            ],
            { placeHolder: '계정 유형 선택' }
        );

        const tier = (tierPick?.value || 'free') as 'free' | 'pro' | 'ultra';

        if (this.accountManager.addAccount(email, name, tier)) {
            this.refresh();
        }
    }

    refresh(): void {
        if (this._view) {
            this.sendDataToWebview();
        }
    }

    private sendDataToWebview(): void {
        if (!this._view) return;

        const accounts = this.accountManager.getAccountsSorted();
        const data = accounts.map(account => ({
            ...account,
            quota: this.quotaCache[account.email] || null,
            hasToken: false // 비동기라서 일단 false
        }));

        // 토큰 상태 비동기 확인
        Promise.all(accounts.map(a => this.tokenService.hasToken(a.email))).then(hasTokens => {
            const dataWithTokens = data.map((d, i) => ({ ...d, hasToken: hasTokens[i] }));
            this._view?.webview.postMessage({ command: 'updateData', data: dataWithTokens });
        });
    }

    private loadQuotaCache(): void {
        try {
            if (fs.existsSync(this.quotaCachePath)) {
                this.quotaCache = JSON.parse(fs.readFileSync(this.quotaCachePath, 'utf-8'));
            }
        } catch {
            this.quotaCache = {};
        }
    }

    private saveQuotaCache(): void {
        try {
            const dir = path.dirname(this.quotaCachePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.quotaCachePath, JSON.stringify(this.quotaCache, null, 2));
        } catch (err) {
            console.error('ReRevolve: Failed to save quota cache', err);
        }
    }

    private getHtmlContent(): string {
        // package.json에서 버전 동적 읽기
        const packageJsonPath = path.join(this.extensionUri.fsPath, 'package.json');
        let version = '0.0.0';
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            version = packageJson.version || '0.0.0';
        } catch {
            console.log('ReRevolve: Could not read package.json version');
        }

        return `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ReRevolve</title>
    <style>
        :root {
            --bg-primary: #1e1e1e;
            --bg-secondary: #252526;
            --bg-tertiary: #2d2d2d;
            --text-primary: #cccccc;
            --text-secondary: #858585;
            --accent-green: #4ec9b0;
            --accent-yellow: #dcdcaa;
            --accent-red: #f14c4c;
            --accent-blue: #569cd6;
            --border-color: #3c3c3c;
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            font-size: 13px;
            padding: 8px;
        }
        
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            margin-bottom: 12px;
            border-bottom: 1px solid var(--border-color);
        }
        
        .header h1 {
            font-size: 14px;
            font-weight: 600;
        }
        
        .header-actions {
            display: flex;
            gap: 8px;
        }
        
        .btn {
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
            padding: 4px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
            transition: background 0.2s;
        }
        
        .btn:hover {
            background: #3c3c3c;
        }
        
        .btn-primary {
            background: var(--accent-blue);
            border-color: var(--accent-blue);
            color: white;
        }
        
        .account-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 0 4px;
        }
        
        .add-account-section {
            padding: 8px 4px;
        }
        
        .account-card {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 10px 8px;
        }
        
        .account-card.active {
            border-color: var(--accent-green);
            box-shadow: 0 0 0 1px var(--accent-green);
        }
        
        .account-card.locked {
            opacity: 0.7;
        }
        
        .account-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 8px;
        }
        
        .account-info {
            flex: 1;
        }
        
        .account-name {
            font-weight: 600;
            font-size: 13px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .account-email {
            color: var(--text-secondary);
            font-size: 11px;
            margin-top: 2px;
        }
        
        .tier-badge {
            font-size: 10px;
            padding: 2px 5px;
            border-radius: 3px;
            cursor: pointer;
        }
        
        .tier-free { background: #3c3c3c; color: #888; }
        .tier-pro { background: #4a3c00; color: #ffc107; }
        .tier-ultra { background: #2d3a4a; color: #64b5f6; }
        
        .quota-badge {
            font-size: 12px;
            font-weight: 600;
            padding: 3px 8px;
            border-radius: 10px;
            min-width: 45px;
            text-align: center;
        }
        
        .quota-high { background: rgba(78, 201, 176, 0.2); color: var(--accent-green); }
        .quota-medium { background: rgba(220, 220, 170, 0.2); color: var(--accent-yellow); }
        .quota-low { background: rgba(241, 76, 76, 0.2); color: var(--accent-red); }
        .quota-unknown { background: var(--bg-tertiary); color: var(--text-secondary); }
        
        .account-details {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
            color: var(--text-secondary);
        }
        
        .reset-time {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        .time-info {
            display: flex;
            flex-direction: column;
            gap: 2px;
            min-width: 0;
            flex-shrink: 1;
        }
        
        .time-row {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        
        .account-actions {
            display: flex;
            gap: 4px;
            flex-shrink: 0;
        }
        
        .icon-btn {
            background: transparent;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            padding: 4px;
            border-radius: 3px;
            font-size: 14px;
        }
        
        .icon-btn:hover {
            background: var(--bg-tertiary);
            color: var(--text-primary);
        }
        
        .icon-btn.token-captured {
            color: var(--accent-yellow);
        }
        
        .icon-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        
        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: var(--text-secondary);
        }
        
        .empty-state p {
            margin-bottom: 12px;
        }
        
        .status-indicator {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 6px;
        }
        
        .status-active { background: var(--accent-green); }
        .status-inactive { background: var(--text-secondary); }
        
        /* 드래그 앤 드롭 스타일 - 개선됨 */
        .account-card {
            position: relative;
            transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        
        .drag-handle {
            display: none;
        }
        
        body.edit-mode .account-card {
            cursor: grab;
            border: 1px dashed var(--border-color);
        }
        
        body.edit-mode .account-card:active {
            cursor: grabbing;
        }
        
        body.edit-mode .account-card.dragging {
            opacity: 0.8;
            box-shadow: 0 8px 20px rgba(0,0,0,0.3);
            transform: scale(1.02);
            z-index: 1000;
        }
        
        body.edit-mode .account-card.drag-over {
            border-top: 3px solid var(--accent-blue);
            margin-top: 10px;
        }
        
        .btn-edit-mode {
            font-size: 12px;
            padding: 4px 8px;
        }
        
        .btn-edit-mode.active {
            background: var(--accent-yellow);
            color: #000;
        }
        
        /* 활성 계정 강조 스타일 */
        .account-card.active {
            border-left: 3px solid var(--accent-green);
            background: linear-gradient(90deg, rgba(46,160,67,0.1) 0%, transparent 100%);
        }
        
        .account-card.active .account-name {
            font-weight: bold;
        }
        
        /* 새로고침 애니메이션 */
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        
        .refreshing .icon-btn:first-child,
        .btn.refreshing {
            animation: spin 1s linear infinite;
        }
        
        .icon-btn.refreshing {
            animation: spin 1s linear infinite;
        }
        
        /* 드롭다운 메뉴 */
        .dropdown {
            position: relative;
            display: inline-block;
        }
        
        .dropdown-menu {
            display: none;
            position: absolute;
            right: 0;
            top: 100%;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            min-width: 120px;
            z-index: 1000;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        
        .dropdown-menu.show {
            display: block;
        }
        
        .dropdown-menu button {
            display: block;
            width: 100%;
            padding: 8px 12px;
            border: none;
            background: transparent;
            color: var(--text-primary);
            text-align: left;
            cursor: pointer;
            font-size: 12px;
        }
        
        .dropdown-menu button:hover {
            background: var(--bg-secondary);
        }
        
        .dropdown-menu button.danger {
            color: var(--accent-red);
        }
        
        .dropdown-menu button.danger:hover {
            background: rgba(241, 76, 76, 0.1);
        }
        
        /* 하단 추가 버튼 패널 */
        .add-account-panel {
            padding: 12px;
            border-top: 1px solid var(--border-color);
            background: var(--bg-primary);
            position: sticky;
            bottom: 0;
        }
        
        .btn-full {
            width: 100%;
            padding: 10px;
            font-size: 14px;
        }
        
        .data-actions {
            display: flex;
            gap: 8px;
            margin-top: 8px;
        }
        
        .btn-secondary {
            flex: 1;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            padding: 6px 10px;
            font-size: 12px;
        }
        
        .btn-secondary:hover {
            background: var(--bg-secondary);
        }
        
        
        /* 정렬 활성 상태 */
        .btn.sort-active {
            background: var(--accent-blue);
            color: #fff;
        }
        
        /* 유틸리티 버튼 그리드 */
        .utility-buttons {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 6px;
            margin-bottom: 12px;
        }
        
        .utility-btn {
            padding: 8px 4px;
            font-size: 10px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            border-radius: 4px;
            cursor: pointer;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 2px;
            transition: all 0.2s ease;
            color: var(--text-primary);
        }
        
        .utility-btn:hover {
            background: var(--bg-secondary);
            border-color: var(--accent-blue);
        }
        
        .utility-btn.blue { border-color: #3b82f6; color: #60a5fa; }
        .utility-btn.green { border-color: #22c55e; color: #4ade80; }
        .utility-btn.yellow { border-color: #eab308; color: #facc15; }
        .utility-btn.red { border-color: #ef4444; color: #f87171; }
        
        /* 하단 데이터 관리 섹션 */
        .data-management-section {
            margin-top: 16px;
            padding-top: 12px;
            border-top: 1px solid var(--border-color);
        }
        
        .data-management-section .section-title {
            font-size: 11px;
            color: var(--text-secondary);
            margin-bottom: 8px;
        }
        
        /* 설정 패널 (접기/펴기) */
        .settings-panel {
            background: var(--bg-primary);
            border-top: 1px solid var(--border-color);
        }
        
        .settings-panel.pinned {
            position: sticky;
            bottom: 0;
        }
        
        .settings-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 12px;
            cursor: pointer;
            background: var(--bg-tertiary);
            border-bottom: 1px solid var(--border-color);
            user-select: none;
        }
        
        .settings-header:hover {
            background: var(--bg-secondary);
        }
        
        .settings-content {
            padding: 12px 8px;
            max-height: 400px;
            overflow: hidden;
            transition: max-height 0.3s ease, padding 0.3s ease;
            background: rgba(0, 0, 0, 0.15);
        }
        
        .settings-content.collapsed {
            max-height: 0;
            padding: 0 8px;
        }
        
        .auto-accept-row {
            display: flex;
            gap: 8px;
            margin-top: 8px;
        }
        
        .btn-auto-accept {
            flex: 1;
            padding: 8px 12px;
            font-size: 13px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            transition: all 0.2s ease;
        }
        
        .btn-auto-accept:hover {
            background: var(--bg-secondary);
        }
        
        .btn-auto-accept.active {
            background: rgba(40, 167, 69, 0.2);
            border-color: #28a745;
            color: #28a745;
        }
        
        .btn-pin {
            padding: 8px 10px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border-color);
            font-size: 12px;
            opacity: 0.5;
            transition: all 0.2s ease;
        }
        
        .btn-pin:hover {
            opacity: 1;
        }
        
        .btn-pin.active {
            opacity: 1;
            background: rgba(59, 130, 246, 0.2);
            border-color: #3b82f6;
        }
        
        /* 로그 섹션 스타일 (설정 내부) */
        .log-section {
            margin-top: 12px;
            border-top: 1px solid var(--border-color);
        }
        
        .log-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 12px;
            background: var(--bg-tertiary);
            border-bottom: 1px solid var(--border-color);
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            user-select: none;
        }
        
        .log-header:hover {
            background: var(--bg-secondary);
        }
        
        .log-content {
            max-height: 150px;
            overflow: hidden;
            transition: max-height 0.3s ease;
        }
        
        .log-content.collapsed {
            max-height: 0;
        }
        
        .log-header .btn-small {
            padding: 2px 6px;
            font-size: 10px;
        }
        
        .log-list {
            flex: 1;
            overflow-y: auto;
            padding: 6px;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 11px;
        }
        
        .log-item {
            padding: 3px 6px;
            border-radius: 4px;
            margin-bottom: 2px;
            display: flex;
            gap: 8px;
        }
        
        .log-item.info {
            background: rgba(96, 165, 250, 0.1);
            color: #60a5fa;
        }
        
        .log-item.success {
            background: rgba(52, 211, 153, 0.1);
            color: #34d399;
        }
        
        .log-item.error {
            background: rgba(248, 113, 113, 0.1);
            color: #f87171;
        }
        
        .log-time {
            color: #858585;
            flex-shrink: 0;
        }
        
        .log-message {
            word-break: break-all;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔄 ReRevolve <span style="font-size:10px;color:#858585;font-weight:normal;">v${version}</span></h1>
        <div class="header-actions">
            <button class="btn" id="sortBtn" onclick="toggleSort()" title="정렬 (기본/쿼터순)">📊</button>
            <button class="btn btn-edit-mode" id="editModeBtn" onclick="toggleEditMode()" title="순서 변경 모드">✏️</button>
            <button class="btn" id="globalRefreshBtn" onclick="refreshAll()" title="전체 새로고침">🔄</button>
        </div>
    </div>
    
    <!-- 설정 패널 (접기/펴기) - 계정 목록 위에 배치 -->
    <div id="settingsPanel" class="settings-panel">
        <div class="settings-header" onclick="toggleSettings()">
            <span>⚙️ 설정</span>
        </div>
        <div id="settingsContent" class="settings-content collapsed">
            <!-- 유틸리티 버튼 그리드 -->
            <div class="utility-buttons">
                <button class="utility-btn blue" onclick="openRules()" title="Rules 편집">📋<br>Rules</button>
                <button class="utility-btn blue" onclick="openMCP()" title="MCP 설정">🔧<br>MCP</button>
                <button class="utility-btn blue" onclick="openAllowlist()" title="Allowlist">🌐<br>Allow</button>
                <button class="utility-btn green" onclick="openBrain()" title="Brain 폴더">🧠<br>Brain</button>
                <button class="utility-btn green" onclick="openCodeTracker()" title="Code Tracker">💾<br>Tracker</button>
                <button class="utility-btn yellow" onclick="restartService()" title="서비스 재시작">🔄<br>Restart</button>
                <button class="utility-btn" onclick="resetCache()" title="캐시 리셋">🗑️<br>Reset</button>
                <button class="utility-btn red" onclick="reloadWindow()" title="창 새로고침">🔁<br>Reload</button>
            </div>
            
            <!-- Auto-Accept 섹션 -->
            <div class="auto-accept-row">
                <button id="autoAcceptBtn" class="btn btn-auto-accept" onclick="toggleAutoAccept()" title="Auto-Accept 토글">
                    <span id="autoAcceptIcon">🔴</span> Auto-Accept
                </button>
                <div class="dropdown">
                    <button class="btn btn-pin dropdown-toggle" onclick="toggleCDPMenu(event)" title="CDP 설정">⚙️</button>
                    <div class="dropdown-menu" id="cdpDropdown">
                        <button onclick="setupCDP()">🔧 CDP 설정</button>
                        <button onclick="removeCDP()">🗑️ CDP 제거</button>
                    </div>
                </div>
                <button id="pinBtn" class="btn btn-pin" onclick="togglePin()" title="하단 고정">
                    <span id="pinIcon">📌</span>
                </button>
            </div>
            
            <!-- 활동 로그 (설정 내부) -->
            <div class="log-section">
                <div class="log-header" onclick="toggleLogs()">
                    <span>📋 활동 로그</span>
                    <div style="display:flex;gap:4px;align-items:center;">
                        <button class="btn btn-small" onclick="event.stopPropagation(); copyLogs()" title="로그 전체 복사">📋</button>
                        <button class="btn btn-small" onclick="event.stopPropagation(); clearLogs()" title="로그 비우기">🗑️</button>
                    </div>
                </div>
                <div id="logContent" class="log-content collapsed">
                    <div id="logList" class="log-list"></div>
                </div>
            </div>
            
            <!-- 데이터 관리 (하단) -->
            <div class="data-management-section">
                <div class="section-title">💾 데이터 관리</div>
                <div class="data-actions">
                    <button class="btn btn-secondary" onclick="exportData()">📤 내보내기</button>
                    <button class="btn btn-secondary" onclick="importData()">📥 가져오기</button>
                </div>
            </div>
        </div>
    </div>
    
    <div id="account-list" class="account-list">
        <div class="empty-state">
            <p>등록된 계정이 없습니다</p>
            <button class="btn btn-primary" onclick="addAccount()">계정 추가</button>
        </div>
    </div>
    
    <!-- 계정 추가 버튼 (계정 목록 아래) -->
    <div class="add-account-section">
        <button class="btn btn-primary btn-full" onclick="addAccount()">➕ 계정 추가</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let accountsData = [];
        let autoAcceptEnabled = false;
        let isPinned = false;
        let isLogVisible = false;

        // 초기 데이터 요청
        vscode.postMessage({ command: 'getInitialData' });

        // 메시지 수신
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateData') {
                accountsData = message.data;
                renderAccounts();
            } else if (message.command === 'autoAcceptStatus') {
                autoAcceptEnabled = message.enabled;
                updateAutoAcceptUI();
            } else if (message.command === 'updateLogs') {
                renderLogs(message.logs);
            }
        });
        
        function toggleLogs() {
            isLogVisible = !isLogVisible;
            const panel = document.getElementById('logPanel');
            const btn = document.getElementById('logToggleBtn');
            
            if (isLogVisible) {
                panel.style.display = 'flex';
                btn.classList.add('active');
            } else {
                panel.style.display = 'none';
                btn.classList.remove('active');
            }
        }
        
        function renderLogs(logs) {
            const container = document.getElementById('logList');
            if (!logs || logs.length === 0) {
                container.innerHTML = '<div style="color:#858585;text-align:center;padding:10px;">로그가 없습니다</div>';
                return;
            }
            
            container.innerHTML = logs.map(log => \`
                <div class="log-item \${log.type}">
                    <span class="log-time">\${log.time}</span>
                    <span class="log-message">\${log.message}</span>
                </div>
            \`).join('');
        }
        
        function clearLogs() {
            const container = document.getElementById('logList');
            container.innerHTML = '<div style="color:#858585;text-align:center;padding:10px;">로그가 없습니다</div>';
            vscode.postMessage({ command: 'clearLogs' });
        }
        
        function toggleAutoAccept() {
            vscode.postMessage({ command: 'toggleAutoAccept' });
        }
        
        function toggleSettings() {
            const content = document.getElementById('settingsContent');
            const arrow = document.getElementById('settingsArrow');
            if (content.classList.contains('collapsed')) {
                content.classList.remove('collapsed');
                arrow.textContent = '▼';
            } else {
                content.classList.add('collapsed');
                arrow.textContent = '▶';
            }
        }
        
        function toggleLogs() {
            const content = document.getElementById('logContent');
            if (content.classList.contains('collapsed')) {
                content.classList.remove('collapsed');
            } else {
                content.classList.add('collapsed');
            }
        }
        
        function togglePin() {
            isPinned = !isPinned;
            const panel = document.getElementById('settingsPanel');
            const pinBtn = document.getElementById('pinBtn');
            const pinIcon = document.getElementById('pinIcon');
            
            if (isPinned) {
                panel.classList.add('pinned');
                pinBtn.classList.add('active');
                pinIcon.textContent = '📍';
            } else {
                panel.classList.remove('pinned');
                pinBtn.classList.remove('active');
                pinIcon.textContent = '📌';
            }
        }
        
        function toggleCDPMenu(event) {
            event.stopPropagation();
            const dropdown = document.getElementById('cdpDropdown');
            dropdown.classList.toggle('show');
            
            // 외부 클릭 시 닫기
            setTimeout(() => {
                document.addEventListener('click', closeCDPMenu);
            }, 0);
        }
        
        function closeCDPMenu() {
            const dropdown = document.getElementById('cdpDropdown');
            dropdown.classList.remove('show');
            document.removeEventListener('click', closeCDPMenu);
        }
        
        function setupCDP() {
            closeCDPMenu();
            vscode.postMessage({ command: 'setupCDP' });
        }
        
        function removeCDP() {
            closeCDPMenu();
            vscode.postMessage({ command: 'removeCDP' });
        }
        
        // 유틸리티 버튼 핸들러
        function openRules() {
            vscode.postMessage({ command: 'openRules' });
        }
        
        function openMCP() {
            vscode.postMessage({ command: 'openMCP' });
        }
        
        function openAllowlist() {
            vscode.postMessage({ command: 'openAllowlist' });
        }
        
        function openBrain() {
            vscode.postMessage({ command: 'openBrain' });
        }
        
        function openCodeTracker() {
            vscode.postMessage({ command: 'openCodeTracker' });
        }
        
        function restartService() {
            vscode.postMessage({ command: 'restartService' });
        }
        
        function resetCache() {
            vscode.postMessage({ command: 'resetCache' });
        }
        
        function reloadWindow() {
            vscode.postMessage({ command: 'reloadWindow' });
        }
        
        // 로그 복사
        function copyLogs() {
            const logList = document.getElementById('logList');
            const logs = logList.innerText || '로그가 없습니다';
            navigator.clipboard.writeText(logs).then(() => {
                vscode.postMessage({ command: 'showMessage', text: '로그가 클립보드에 복사되었습니다!' });
            });
        }
        
        function updateAutoAcceptUI() {
            const btn = document.getElementById('autoAcceptBtn');
            const icon = document.getElementById('autoAcceptIcon');
            if (autoAcceptEnabled) {
                btn.classList.add('active');
                icon.textContent = '🟢';
            } else {
                btn.classList.remove('active');
                icon.textContent = '🔴';
            }
        }

        function renderAccounts() {
            const container = document.getElementById('account-list');
            
            if (accountsData.length === 0) {
                container.innerHTML = \`
                    <div class="empty-state">
                        <p>등록된 계정이 없습니다</p>
                        <button class="btn btn-primary" onclick="addAccount()">계정 추가</button>
                    </div>
                \`;
                return;
            }

            container.innerHTML = getSortedAccounts().map(account => {
                const quota = account.quota;
                const remaining = quota?.claudeRemaining ?? -1;
                const resetTimeRaw = quota?.claudeResetTime || '';
                
                // 예상 충전 시간 계산 (갱신 시점 + 남은 충전 시간)
                let resetDisplay = '정보 없음';
                if (quota?.lastUpdated && resetTimeRaw) {
                    const lastUpdatedDate = new Date(quota.lastUpdated);
                    // resetTimeRaw는 "7일 0시간", "4시간 58분" 같은 형태
                    const dayMatch = resetTimeRaw.match(/(\\d+)일/);
                    const hourMatch = resetTimeRaw.match(/(\\d+)시간/);
                    const minuteMatch = resetTimeRaw.match(/(\\d+)분/);
                    const days = dayMatch ? parseInt(dayMatch[1]) : 0;
                    const hours = hourMatch ? parseInt(hourMatch[1]) : 0;
                    const minutes = minuteMatch ? parseInt(minuteMatch[1]) : 0;
                    
                    const totalMinutes = days * 24 * 60 + hours * 60 + minutes;
                    const resetDate = new Date(lastUpdatedDate.getTime() + totalMinutes * 60 * 1000);
                    const month = resetDate.getMonth() + 1;
                    const day = resetDate.getDate();
                    const h = resetDate.getHours();
                    const m = String(resetDate.getMinutes()).padStart(2, '0');
                    const ampm = h >= 12 ? '오후' : '오전';
                    const hour12 = h % 12 || 12;
                    resetDisplay = month + '/' + day + ' ' + ampm + ' ' + hour12 + ':' + m;
                }
                
                // 갱신 시간 표시 (날짜 포함)
                let updatedDisplay = '-';
                if (quota?.lastUpdated) {
                    const d = new Date(quota.lastUpdated);
                    const month = d.getMonth() + 1;
                    const day = d.getDate();
                    const h = d.getHours();
                    const m = String(d.getMinutes()).padStart(2, '0');
                    const ampm = h >= 12 ? '오후' : '오전';
                    const hour12 = h % 12 || 12;
                    updatedDisplay = month + '/' + day + ' ' + ampm + ' ' + hour12 + ':' + m;
                }
                
                let quotaClass = 'quota-unknown';
                let quotaText = '?';
                if (remaining >= 0) {
                    quotaText = remaining + '%';
                    if (remaining > 50) quotaClass = 'quota-high';
                    else if (remaining > 20) quotaClass = 'quota-medium';
                    else quotaClass = 'quota-low';
                }

                const tierClass = 'tier-' + account.tier;
                const tierLabel = account.tier === 'ultra' ? '💎' : account.tier === 'pro' ? '⭐' : '🆓';
                const isLocked = account.refreshLocked;
                const hasToken = account.hasToken;

                // 남은 시간 표시용
                const resetTimeDisplay = resetTimeRaw || '정보 없음';

                return \`
                    <div class="account-card \${account.isActive ? 'active' : ''} \${isLocked ? 'locked' : ''}" data-email="\${account.email}" draggable="false">
                        <div class="drag-handle" title="드래그하여 순서 변경">⋮⋮</div>
                        <div class="account-header">
                            <div class="account-info">
                                <div class="account-name">
                                    \${account.isActive ? '<span class="status-indicator status-active"></span>' : ''}
                                    \${account.name}
                                    <span class="tier-badge \${tierClass}" onclick="toggleTier('\${account.email}')" title="클릭하여 유형 변경">\${tierLabel}</span>
                                    \${isLocked ? '🔒' : ''}
                                </div>
                                <div class="account-email">\${account.email} \${hasToken ? '<span style="color:#4ade80;" title="토큰 캡처됨">🔑</span>' : '<span style="color:#f87171;" title="토큰 없음">❌</span>'}</div>
                            </div>
                            <span class="quota-badge \${quotaClass}">\${quotaText}</span>
                        </div>
                        <div class="account-details">
                            <div class="time-info">
                                <div class="time-row">⏰ 남은 시간: \${resetTimeDisplay}</div>
                                <div class="time-row">🔋 재충전 예정: \${resetDisplay}</div>
                                <div class="time-row" style="font-size:11px;color:#666;">📅 마지막 갱신: \${updatedDisplay}</div>
                            </div>
                            <div class="account-actions">
                                <button class="icon-btn" 
                                        onclick="refreshAccount('\${account.email}')" 
                                        title="새로고침"
                                        \${isLocked ? 'disabled' : ''}>🔄</button>
                                <div class="dropdown">
                                    <button class="icon-btn dropdown-toggle" onclick="toggleDropdown(event, '\${account.email}')">⋮</button>
                                    <div class="dropdown-menu" id="dropdown-\${account.email.replace(/[@.]/g, '_')}">
                                        <button onclick="captureToken('\${account.email}')">🔑 토큰 캡처</button>
                                        <button onclick="switchToAccount('\${account.email}')">🔄 계정 전환</button>
                                        <button onclick="editAccountName('\${account.email}')">✏️ 이름 수정</button>
                                        <button onclick="removeAccount('\${account.email}')" class="danger">🗑️ 삭제</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                \`;
            }).join('');
            
            // 편집 모드일 때 드래그 이벤트 재설정
            if (editMode) {
                const cards = document.querySelectorAll('.account-card');
                cards.forEach(card => card.setAttribute('draggable', 'true'));
                initDragAndDrop();
            }
        }

        function refreshAll() {
            const btn = document.getElementById('globalRefreshBtn');
            if (btn) btn.classList.add('refreshing');
            vscode.postMessage({ command: 'refreshAll' });
            // 애니메이션은 데이터 업데이트 시 자동 제거됨
            setTimeout(() => btn?.classList.remove('refreshing'), 5000);
        }

        function exportData() {
            vscode.postMessage({ command: 'exportData' });
        }

        function importData() {
            vscode.postMessage({ command: 'importData' });
        }

        function refreshAccount(email) {
            vscode.postMessage({ command: 'refreshAccount', email });
        }

        function captureToken(email) {
            vscode.postMessage({ command: 'captureToken', email });
        }

        function switchToAccount(email) {
            vscode.postMessage({ command: 'switchAccount', email });
        }

        function addAccount() {
            vscode.postMessage({ command: 'addAccount' });
        }

        function removeAccount(email) {
            // 확인은 백엔드에서 vscode API로 처리
            vscode.postMessage({ command: 'removeAccount', email });
        }

        function toggleTier(email) {
            vscode.postMessage({ command: 'toggleTier', email });
        }

        // ============ 정렬 기능 ============
        let sortMode = 'default'; // 'default' or 'quota'
        
        function toggleSort() {
            sortMode = sortMode === 'default' ? 'quota' : 'default';
            const btn = document.getElementById('sortBtn');
            btn.classList.toggle('sort-active', sortMode === 'quota');
            btn.title = sortMode === 'quota' ? '정렬 (쿼터순 활성)' : '정렬 (기본순)';
            renderAccounts();
        }
        
        function getSortedAccounts() {
            if (sortMode === 'default') {
                return [...accountsData];
            }
            
            // 쿼터순 정렬: 쿼터 큰순 > 유료 우선 > 재충전 빠른순
            return [...accountsData].sort((a, b) => {
                const quotaA = a.quota?.claudeRemaining ?? -1;
                const quotaB = b.quota?.claudeRemaining ?? -1;
                
                // 1. 쿼터 큰 순
                if (quotaA !== quotaB) return quotaB - quotaA;
                
                // 2. 같은 쿼터면 유료 우선 (pro/ultra > free)
                const tierOrder = { 'ultra': 0, 'pro': 1, 'free': 2 };
                const tierA = tierOrder[a.tier] ?? 2;
                const tierB = tierOrder[b.tier] ?? 2;
                if (tierA !== tierB) return tierA - tierB;
                
                // 3. 0% 끼리는 재충전 빠른순
                if (quotaA === 0 && quotaB === 0) {
                    const resetA = parseResetTime(a.quota?.claudeResetTime);
                    const resetB = parseResetTime(b.quota?.claudeResetTime);
                    return resetA - resetB;
                }
                
                return 0;
            });
        }
        
        function parseResetTime(resetTimeRaw) {
            if (!resetTimeRaw) return Infinity;
            const dayMatch = resetTimeRaw.match(/(\\d+)일/);
            const hourMatch = resetTimeRaw.match(/(\\d+)시간/);
            const minuteMatch = resetTimeRaw.match(/(\\d+)분/);
            const days = dayMatch ? parseInt(dayMatch[1]) : 0;
            const hours = hourMatch ? parseInt(hourMatch[1]) : 0;
            const minutes = minuteMatch ? parseInt(minuteMatch[1]) : 0;
            return days * 24 * 60 + hours * 60 + minutes;
        }

        function toggleDropdown(event, email) {
            event.stopPropagation();
            const menuId = 'dropdown-' + email.replace(/[@.]/g, '_');
            const menu = document.getElementById(menuId);
            const isOpen = menu?.classList.contains('show');
            
            // 모든 드롭다운 닫기
            document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
            
            // 현재 메뉴가 닫혀있었으면 열기
            if (!isOpen && menu) menu.classList.add('show');
        }

        function editAccountName(email) {
            closeAllDropdowns();
            vscode.postMessage({ command: 'editAccount', email });
        }

        function closeAllDropdowns() {
            document.querySelectorAll('.dropdown-menu.show').forEach(menu => menu.classList.remove('show'));
        }

        // 문서 클릭 시 드롭다운 닫기
        document.addEventListener('click', closeAllDropdowns);

        // ============ 편집 모드 및 드래그 앤 드롭 ============
        let editMode = false;
        let draggedElement = null;

        function toggleEditMode() {
            editMode = !editMode;
            document.body.classList.toggle('edit-mode', editMode);
            document.getElementById('editModeBtn').classList.toggle('active', editMode);
            const cards = document.querySelectorAll('.account-card');
            cards.forEach(card => card.setAttribute('draggable', editMode ? 'true' : 'false'));
            if (editMode) initDragAndDrop();
        }

        function initDragAndDrop() {
            const cards = document.getElementById('account-list').querySelectorAll('.account-card');
            cards.forEach(card => {
                card.ondragstart = handleDragStart;
                card.ondragend = handleDragEnd;
                card.ondragover = handleDragOver;
                card.ondrop = handleDrop;
            });
        }

        function handleDragStart(e) {
            draggedElement = e.target.closest('.account-card');
            if (!draggedElement) return;
            draggedElement.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', draggedElement.dataset.email);
        }

        function handleDragEnd(e) {
            const card = e.target.closest('.account-card');
            if (card) card.classList.remove('dragging');
            document.querySelectorAll('.account-card').forEach(c => c.classList.remove('drag-over'));
            
            // 순서 저장 후 이벤트 재설정
            if (draggedElement) {
                const container = document.getElementById('account-list');
                const newOrder = [...container.querySelectorAll('.account-card')].map(c => c.dataset.email);
                vscode.postMessage({ command: 'reorderAccounts', order: newOrder });
            }
            draggedElement = null;
            
            // 드래그 가능 상태 유지 및 이벤트 재바인딩
            setTimeout(() => {
                if (editMode) initDragAndDrop();
            }, 100);
        }

        function handleDragOver(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            const targetCard = e.target.closest('.account-card');
            if (!targetCard || !draggedElement || targetCard === draggedElement) return;
            
            const container = document.getElementById('account-list');
            const cards = [...container.querySelectorAll('.account-card')];
            const draggedIdx = cards.indexOf(draggedElement);
            const targetIdx = cards.indexOf(targetCard);
            
            // 실시간 위치 교환 (부드럽게)
            if (draggedIdx < targetIdx) {
                container.insertBefore(draggedElement, targetCard.nextSibling);
            } else {
                container.insertBefore(draggedElement, targetCard);
            }
        }

        function handleDrop(e) {
            e.preventDefault();
            // 실제 저장은 dragEnd에서 처리
        }

        // ============ 활성 계정 30초 자동 갱신 ============
        // refreshActiveOnly를 호출하여 현재 로그인 계정만 실시간 감지 후 갱신
        setInterval(() => {
            console.log('ReRevolve: 30초 자동 갱신 실행');
            vscode.postMessage({ command: 'refreshActiveOnly' });
        }, 30000);
    </script>
</body>
</html>`;
    }
}
