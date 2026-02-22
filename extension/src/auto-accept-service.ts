/**
 * Auto-Accept Service v6.9.0 - 통합 버전
 * 
 * Git v6.7.5 (pesosz 방식, 안정성 설계) + v6.8.0 (확장 명령어, 설정 토글 연동) 합본
 * 
 * 설계 원칙:
 * - 비차단 poll: await 사용 금지 → UI 프리징 방지
 * - globalState: 재시작 시 ON/OFF 상태 복원
 * - EventEmitter: 정식 VS Code 이벤트 패턴
 * - 10개 Accept 명령어: 모든 수락 UI 자동 처리
 * - 설정 토글 연동: ON 시 settings.json 주입 + browserAllowlist 생성, OFF 시 원복
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ===== Accept 명령어 목록 (v6.8.0 확장) =====
// ⚠️ terminalCommand.run은 "실행" 명령이라 자동 호출 금지
const ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',              // 에이전트 스텝 승인 (Accept All)
    'antigravity.terminalCommand.accept',              // 터미널 명령 승인 (alt+enter)
    'antigravity.command.accept',                      // 일반 명령 승인 (ctrl+enter)
    'antigravity.prioritized.agentAcceptAllInFile',    // 파일 내 전체 변경 수락
    'antigravity.prioritized.agentAcceptFocusedHunk',  // 포커스된 Hunk 수락
    'antigravity.prioritized.supercompleteAccept',     // Supercomplete 수락
    'antigravity.acceptCompletion',                    // 자동완성 수락
    'antigravity.prioritized.terminalSuggestion.accept', // 터미널 제안 수락
    'antigravity.prioritized.tabJumpAccept',           // Tab Jump 수락
    'antigravity.cascade.acceptSuggestedAction'        // Cascade 제안 수락
];

// ===== Auto-Accept가 관리하는 설정 키 =====
const MANAGED_SETTINGS: Record<string, { on: any; off: any }> = {
    'cached.allowAgentAccessNonWorkspaceFiles': { on: true, off: undefined },
    'cached.terminalAutoExecutionPolicy': { on: 'autoExecute', off: undefined },
    'cached.allowCascadeAccessGitignoreFiles': { on: true, off: undefined },
    'cached.artifactReviewPolicy': { on: 'autoApply', off: undefined },
    'security.workspace.trust.untrustedFiles': { on: 'open', off: undefined }
};

const STATE_KEY = 'autoAcceptEnabled';
const POLL_INTERVAL = 700; // 700ms: 1000ms(안정)와 200ms(빠름)의 절충

export class AutoAcceptService implements vscode.Disposable {
    private _enabled = false;
    private pollTimer: NodeJS.Timeout | null = null;
    private globalState: vscode.Memento;

    // 상태 변경 이벤트 (정식 VS Code EventEmitter 패턴)
    private readonly _onStatusChange = new vscode.EventEmitter<boolean>();
    public readonly onStatusChange = this._onStatusChange.event;

    constructor(globalState: vscode.Memento) {
        this.globalState = globalState;
    }

    get isEnabled(): boolean {
        return this._enabled;
    }

    /**
     * Auto-Accept 시작 + 설정 자동 주입
     */
    async start(): Promise<void> {
        if (this._enabled) return;

        this._enabled = true;
        this._onStatusChange.fire(true);
        this.globalState.update(STATE_KEY, true);

        // 설정 자동 주입 (ON 시)
        this.applySettings();

        // 비차단 폴링 시작 (await 사용 안 함 → UI 프리징 방지)
        this.pollTimer = setInterval(() => {
            if (!this._enabled) return;
            this.poll();
        }, POLL_INTERVAL);

        console.log(`ReRevolve: Auto-Accept ON (${POLL_INTERVAL}ms, ${ACCEPT_COMMANDS.length}개 명령어)`);
    }

    /**
     * Auto-Accept 중지 + 설정 원복
     */
    stop(): void {
        if (!this._enabled) return;

        this._enabled = false;
        this._onStatusChange.fire(false);
        this.globalState.update(STATE_KEY, false);

        // 설정 원복 (OFF 시)
        this.revertSettings();

        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }

        console.log('ReRevolve: Auto-Accept OFF (설정 원복 완료)');
    }

    /**
     * 토글
     */
    toggle(): boolean {
        if (this._enabled) {
            this.stop();
            vscode.window.showInformationMessage('🛑 Auto-Accept OFF (설정 원복됨)');
        } else {
            this.start();
            vscode.window.showInformationMessage(`🚀 Auto-Accept ON (${POLL_INTERVAL}ms, 설정 자동 적용)`);
        }
        return this._enabled;
    }

    /**
     * 저장된 상태 복원 (확장 시작 시 호출)
     */
    restoreState(): void {
        const saved = this.globalState.get<boolean>(STATE_KEY, false);
        if (saved) {
            this.start();
        }
    }

    // ===== 비차단 폴링 =====
    private poll(): void {
        for (const cmd of ACCEPT_COMMANDS) {
            vscode.commands.executeCommand(cmd).then(
                () => { },
                () => { } // 승인할 것이 없으면 조용히 무시
            );
        }
    }

    // ===== 설정 주입 (ON 시) =====
    private applySettings(): void {
        try {
            const config = vscode.workspace.getConfiguration();
            for (const [key, values] of Object.entries(MANAGED_SETTINGS)) {
                config.update(key, values.on, vscode.ConfigurationTarget.Global)
                    .then(() => { }, () => { });
            }

            // browserAllowlist.txt 생성
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
            } else {
                const existing = fs.readFileSync(allowlistPath, 'utf-8');
                if (!existing.includes('https://*/*')) {
                    fs.appendFileSync(allowlistPath, '\nhttps://*/*\nhttp://*/*\n', 'utf-8');
                }
            }
            console.log('ReRevolve: 설정 + browserAllowlist 적용 완료');
        } catch (err) {
            console.error('ReRevolve: 설정 적용 실패', err);
        }
    }

    // ===== 설정 원복 (OFF 시) =====
    private revertSettings(): void {
        try {
            const config = vscode.workspace.getConfiguration();
            for (const [key, values] of Object.entries(MANAGED_SETTINGS)) {
                config.update(key, values.off, vscode.ConfigurationTarget.Global)
                    .then(() => { }, () => { });
            }

            // browserAllowlist.txt 삭제
            const userProfile = process.env.USERPROFILE || process.env.HOME || '';
            const allowlistPath = path.join(userProfile, '.gemini', 'antigravity', 'browserAllowlist.txt');
            if (fs.existsSync(allowlistPath)) {
                fs.unlinkSync(allowlistPath);
            }
            console.log('ReRevolve: 설정 + browserAllowlist 원복 완료');
        } catch (err) {
            console.error('ReRevolve: 설정 원복 실패', err);
        }
    }

    dispose(): void {
        this.stop();
        this._onStatusChange.dispose();
    }
}
