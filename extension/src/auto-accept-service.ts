/**
 * Auto-Accept Service v8.0.0 - CDP 통합 + 세션 동기화
 * 
 * v7.0.0 (명령어 폴링 + Auto-Run 패치) + CDP DOM 클릭 (AAA 기반) 통합
 * 
 * 설계 원칙:
 * - 이중 보호: CDP DOM 클릭 + VS Code 명령어 폴링 병행
 * - 세션 동기화: globalState → Configuration으로 전환, 모든 창에서 동기화
 * - CDP graceful fallback: CDP 불가 시 기존 명령어 폴링만 사용
 * - 비차단 poll: await 사용 금지 → UI 프리징 방지
 * - EventEmitter: 정식 VS Code 이벤트 패턴
 * - Auto-Run 패치: Antigravity JS 파일에 누락된 useEffect 주입
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { autoApply } from './auto-run-patcher';
import { CdpSetupService } from './cdp-setup-service';
import { CDPHandler } from './cdp-handler';

// ===== Accept 명령어 목록 =====
const ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.terminalCommand.accept',
    'antigravity.command.accept',
    'antigravity.prioritized.agentAcceptAllInFile',
    'antigravity.prioritized.agentAcceptFocusedHunk',
    'antigravity.prioritized.supercompleteAccept',
    'antigravity.acceptCompletion',
    'antigravity.prioritized.terminalSuggestion.accept',
    'antigravity.prioritized.tabJumpAccept',
    'antigravity.cascade.acceptSuggestedAction'
];


// 세션 동기화용 Configuration 키
const CONFIG_KEY = 'rerevolve.autoAcceptEnabled';
const RETRY_CONFIG_KEY = 'rerevolve.autoRetryEnabled';
const STATE_KEY = 'autoAcceptEnabled';
const RETRY_STATE_KEY = 'autoRetryEnabled';
const POLL_INTERVAL = 5000;

export class AutoAcceptService implements vscode.Disposable {
    private _enabled = false;
    private _retryEnabled = false;
    private pollTimer: NodeJS.Timeout | null = null;
    private globalState: vscode.Memento;
    private cdpHandler: CDPHandler;
    private cdpConnected = false;
    private configChangeDisposable: vscode.Disposable | null = null;

    // 상태 변경 이벤트
    private readonly _onStatusChange = new vscode.EventEmitter<{ enabled: boolean; retryEnabled: boolean; cdp: boolean }>();
    public readonly onStatusChange = this._onStatusChange.event;

    constructor(globalState: vscode.Memento) {
        this.globalState = globalState;
        this.cdpHandler = new CDPHandler((msg) => console.log(`ReRevolve: ${msg}`));

        // 다른 창에서 설정 변경 감지 → 동기화
        this.configChangeDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('rerevolve.autoAcceptEnabled')) {
                const config = vscode.workspace.getConfiguration('rerevolve');
                const shouldBeEnabled = config.get<boolean>('autoAcceptEnabled', false);

                if (shouldBeEnabled && !this._enabled) {
                    this.start(true); // 동기화에 의한 시작 (설정 재기록 방지)
                } else if (!shouldBeEnabled && this._enabled) {
                    this.stop(true); // 동기화에 의한 중지
                }
            }
            if (e.affectsConfiguration('rerevolve.autoRetryEnabled')) {
                const config = vscode.workspace.getConfiguration('rerevolve');
                const shouldBeEnabled = config.get<boolean>('autoRetryEnabled', false);

                if (shouldBeEnabled && !this._retryEnabled) {
                    this.startRetry(true);
                } else if (!shouldBeEnabled && this._retryEnabled) {
                    this.stopRetry(true);
                }
            }
        });
    }

    get isEnabled(): boolean {
        return this._enabled;
    }

    get isCDPConnected(): boolean {
        return this.cdpConnected;
    }

    get isAutoRetryEnabled(): boolean {
        return this._retryEnabled;
    }

    private get shouldRunAutomation(): boolean {
        return this._enabled || this._retryEnabled;
    }

    /**
     * Auto-Accept 시작 + CDP + 설정 자동 주입
     */
    async start(fromSync = false): Promise<void> {
        if (this._enabled) return;

        this._enabled = true;

        // 세션 동기화: Configuration에 상태 기록 (동기화에 의한 호출이 아닐 때만)
        if (!fromSync) {
            const config = vscode.workspace.getConfiguration('rerevolve');
            config.update('autoAcceptEnabled', true, vscode.ConfigurationTarget.Global)
                .then(() => {}, () => {});
        }

        // globalState에도 백업
        this.globalState.update(STATE_KEY, true);

        this.ensureAutomationLoop();

        this._onStatusChange.fire({ enabled: true, retryEnabled: this._retryEnabled, cdp: this.cdpConnected });
        console.log(`ReRevolve: Auto-Accept ON (${POLL_INTERVAL}ms, CDP ${this.cdpConnected ? 'ON' : 'pending'})`);
    }

    /**
     * Auto-Accept 중지 + CDP 종료 + 설정 원복
     */
    async stop(fromSync = false): Promise<void> {
        if (!this._enabled) return;

        this._enabled = false;

        // 세션 동기화
        if (!fromSync) {
            const config = vscode.workspace.getConfiguration('rerevolve');
            config.update('autoAcceptEnabled', false, vscode.ConfigurationTarget.Global)
                .then(() => {}, () => {});
        }

        this.globalState.update(STATE_KEY, false);

        await this.stopAutomationIfIdle();

        this._onStatusChange.fire({ enabled: false, retryEnabled: this._retryEnabled, cdp: this.cdpConnected });
        console.log('ReRevolve: Auto-Accept OFF (설정 원복 완료)');
    }

    /**
     * 토글
     */
    async toggle(): Promise<boolean> {
        if (this._enabled) {
            await this.stop();
            vscode.window.showInformationMessage('🛑 Auto-Accept OFF (설정 원복됨)');
        } else {
            // CDP 설정 확인 (첫 실행 시) — 거부하면 ON하지 않음
            const cdpReady = await CdpSetupService.ensureSetup(this.globalState);
            if (!cdpReady) {
                vscode.window.showWarningMessage('⚠️ CDP 설정을 건너뛰어 Auto-Accept를 켤 수 없습니다. 다시 시도하려면 토글을 누르세요.');
                return false;
            }
            await this.start();
            const cdpStatus = this.cdpConnected ? ' (CDP 연결)' : '';
            vscode.window.showInformationMessage(`🚀 Auto-Accept ON${cdpStatus}`);
        }
        return this._enabled;
    }

    async startRetry(fromSync = false): Promise<void> {
        if (this._retryEnabled) return;

        this._retryEnabled = true;
        if (!fromSync) {
            const config = vscode.workspace.getConfiguration('rerevolve');
            config.update('autoRetryEnabled', true, vscode.ConfigurationTarget.Global)
                .then(() => {}, () => {});
        }
        this.globalState.update(RETRY_STATE_KEY, true);
        this.ensureAutomationLoop();
        this._onStatusChange.fire({ enabled: this._enabled, retryEnabled: true, cdp: this.cdpConnected });
        console.log(`ReRevolve: Auto-Retry ON (${POLL_INTERVAL}ms, CDP ${this.cdpConnected ? 'ON' : 'pending'})`);
    }

    async stopRetry(fromSync = false): Promise<void> {
        if (!this._retryEnabled) return;

        this._retryEnabled = false;
        if (!fromSync) {
            const config = vscode.workspace.getConfiguration('rerevolve');
            config.update('autoRetryEnabled', false, vscode.ConfigurationTarget.Global)
                .then(() => {}, () => {});
        }
        this.globalState.update(RETRY_STATE_KEY, false);
        await this.stopAutomationIfIdle();
        this._onStatusChange.fire({ enabled: this._enabled, retryEnabled: false, cdp: this.cdpConnected });
        console.log('ReRevolve: Auto-Retry OFF');
    }

    async toggleRetry(): Promise<boolean> {
        if (this._retryEnabled) {
            await this.stopRetry();
            vscode.window.showInformationMessage('🛑 Auto-Retry OFF');
        } else {
            const cdpReady = await CdpSetupService.ensureSetup(this.globalState);
            if (!cdpReady) {
                vscode.window.showWarningMessage('⚠️ CDP 설정을 건너뛰어 Auto-Retry를 켤 수 없습니다. 다시 시도하려면 토글을 누르세요.');
                return false;
            }
            await this.startRetry();
            const cdpStatus = this.cdpConnected ? ' (CDP 연결)' : '';
            vscode.window.showInformationMessage(`🔁 Auto-Retry ON${cdpStatus}`);
        }
        return this._retryEnabled;
    }

    /**
     * 저장된 상태 복원
     */
    restoreState(): void {
        // Configuration 우선, globalState 폴백
        const config = vscode.workspace.getConfiguration('rerevolve');
        const configEnabled = config.get<boolean>('autoAcceptEnabled', false);
        const configRetryEnabled = config.get<boolean>('autoRetryEnabled', false);
        const stateEnabled = this.globalState.get<boolean>(STATE_KEY, false);
        const stateRetryEnabled = this.globalState.get<boolean>(RETRY_STATE_KEY, false);

        if (configEnabled || stateEnabled) {
            this.start(configEnabled); // config에서 온 경우 동기화 재기록 방지
        }
        if (configRetryEnabled || stateRetryEnabled) {
            this.startRetry(configRetryEnabled);
        }
    }

    /**
     * CDP 설정 (사이드바에서 호출)
     */
    async setupCDP(): Promise<void> {
        await CdpSetupService.setupAll();
        vscode.window.showInformationMessage('✅ CDP 설정 완료! Antigravity 재시작 후 적용됩니다.');
    }

    /**
     * CDP 설정 제거 (사이드바에서 호출)
     */
    async removeCDP(): Promise<void> {
        await CdpSetupService.removeSetup(this.globalState);
    }

    // ===== CDP 연결 =====
    private async startCDP(): Promise<void> {
        try {
            const available = await this.cdpHandler.isCDPAvailable();
            if (available) {
                this.cdpConnected = true;
                this._onStatusChange.fire({ enabled: this._enabled, retryEnabled: this._retryEnabled, cdp: true });
                console.log('ReRevolve: CDP 연결 성공 (상태 비저장 감시 프로세스 활성화)');
            } else {
                this.cdpConnected = false;
                console.log('ReRevolve: CDP 미가용 (명령어 폴링만 사용)');
            }
        } catch (err) {
            this.cdpConnected = false;
            console.log(`ReRevolve: CDP 연결 실패 (명령어 폴링만 사용): ${err}`);
        }
    }

    // ===== CDP 폴링 (AAA v13 패턴) =====
    // 버튼 클릭은 CDP 주입 스크립트가 처리 (VS Code 명령어 사용하지 않음)
    // 폴링은 CDP 연결 유지 + 새 페이지 감지 목적으로만 사용
    private poll(): void {
        if (this.cdpConnected && this.shouldRunAutomation) {
            this.cdpHandler.start({
                ide: 'antigravity',
                pollInterval: 1000,
                enableAccept: this._enabled,
                enableRetry: this._retryEnabled
            }).catch(() => {});
        }
    }

    private ensureAutomationLoop(): void {
        this.applyAutoRunPatch();
        this.startCDP();
        if (!this.pollTimer) {
            this.pollTimer = setInterval(() => {
                if (!this.shouldRunAutomation) return;
                this.poll();
            }, POLL_INTERVAL);
        }
    }

    private async stopAutomationIfIdle(): Promise<void> {
        if (this.shouldRunAutomation) {
            this.poll();
            return;
        }

        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }

        if (this.cdpConnected) {
            await this.cdpHandler.stop();
            this.cdpConnected = false;
        }
    }


    // ===== Auto-Run 패치 =====
    private applyAutoRunPatch(): void {
        autoApply().then(results => {
            for (const r of results) {
                if (r.status === 'patched') {
                    console.log(`ReRevolve: ✅ [${r.label}] Auto-Run 패치 적용 (+${r.bytesAdded} bytes)`);
                    if (r.details) console.log(`  → ${r.details}`);
                } else if (r.status === 'already-patched') {
                    console.log(`ReRevolve: ✓ [${r.label}] 이미 패치됨`);
                } else if (r.status === 'ba-patched') {
                    console.log(`ReRevolve: ✓ [${r.label}] ${r.details}`);
                } else if (r.status === 'pattern-not-found') {
                    console.log(`ReRevolve: ⚠ [${r.label}] ${r.details}`);
                } else if (r.status === 'error') {
                    console.error(`ReRevolve: ❌ [${r.label}] 패치 실패: ${r.error}`);
                }
            }
        }).catch(err => {
            console.error('ReRevolve: Auto-Run 패치 실행 실패', err);
        });
    }

    dispose(): void {
        this.stop();
        this._onStatusChange.dispose();
        if (this.configChangeDisposable) {
            this.configChangeDisposable.dispose();
        }
    }
}
