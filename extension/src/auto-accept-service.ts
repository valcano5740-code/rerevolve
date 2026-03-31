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
const STATE_KEY = 'autoAcceptEnabled';
const POLL_INTERVAL = 5000;

export class AutoAcceptService implements vscode.Disposable {
    private _enabled = false;
    private pollTimer: NodeJS.Timeout | null = null;
    private globalState: vscode.Memento;
    private cdpHandler: CDPHandler;
    private cdpConnected = false;
    private configChangeDisposable: vscode.Disposable | null = null;

    // 상태 변경 이벤트
    private readonly _onStatusChange = new vscode.EventEmitter<{ enabled: boolean; cdp: boolean }>();
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
        });
    }

    get isEnabled(): boolean {
        return this._enabled;
    }

    get isCDPConnected(): boolean {
        return this.cdpConnected;
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


        // Auto-Run 패치
        this.applyAutoRunPatch();

        // CDP 연결 시도 (non-blocking)
        this.startCDP();

        // 비차단 폴링 시작 (CDP와 병행)
        this.pollTimer = setInterval(() => {
            if (!this._enabled) return;
            this.poll();
        }, POLL_INTERVAL);

        this._onStatusChange.fire({ enabled: true, cdp: this.cdpConnected });
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

        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }

        // CDP 중지
        if (this.cdpConnected) {
            await this.cdpHandler.stop();
            this.cdpConnected = false;
        }

        this._onStatusChange.fire({ enabled: false, cdp: false });
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
            // CDP 설정 확인 (첫 실행 시)
            await CdpSetupService.ensureSetup(this.globalState);
            await this.start();
            const cdpStatus = this.cdpConnected ? ' (CDP 연결)' : '';
            vscode.window.showInformationMessage(`🚀 Auto-Accept ON${cdpStatus}`);
        }
        return this._enabled;
    }

    /**
     * 저장된 상태 복원
     */
    restoreState(): void {
        // Configuration 우선, globalState 폴백
        const config = vscode.workspace.getConfiguration('rerevolve');
        const configEnabled = config.get<boolean>('autoAcceptEnabled', false);
        const stateEnabled = this.globalState.get<boolean>(STATE_KEY, false);

        if (configEnabled || stateEnabled) {
            this.start(configEnabled); // config에서 온 경우 동기화 재기록 방지
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
                this._onStatusChange.fire({ enabled: true, cdp: true });
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

    // ===== 비차단 폴링 =====
    private poll(): void {
        for (const cmd of ACCEPT_COMMANDS) {
            vscode.commands.executeCommand(cmd).then(
                () => { },
                () => { }
            );
        }

        // 다중 창 환경(단일 프로세스 공유) 대응:
        // 백그라운드 웹소켓을 계속 열어두면 연결 탈취(Steal)로 구멍이 발생하므로,
        // Stateless 구조로 700ms마다 실행여부 점검 및 부족한 창에 명령 보강 주입
        if (this.cdpConnected) {
            this.cdpHandler.start({ ide: 'antigravity', pollInterval: 1000 }).catch(() => {});
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
