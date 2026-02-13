/**
 * Auto-Accept Service - pesosz 방식 (VS Code 내부 명령어 직접 호출)
 * 
 * pesosz/antigravity-auto-accept (v1.0.3, 21,000+ 다운로드) 분석 결과:
 * - antigravity.agent.acceptAgentStep (에이전트 스텝/Accept All 승인)
 * - antigravity.terminal.accept (터미널 명령 승인)
 * 이 두 명령어를 500ms 인터벌로 실행하는 것이 전부.
 * 
 * CDP 방식은 Accept All 버튼이 Electron 네이티브 UI에 있어 접근 불가 확인.
 * → CDP 코드 제거, pesosz 방식으로 전환 (v6.7.0)
 */

import * as vscode from 'vscode';

// Antigravity 내부 Accept 명령어 (extensions/antigravity/package.json 검증 완료)
// ⚠️ terminalCommand.run은 "실행" 명령이라 자동 호출 금지
const ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',     // 에이전트 스텝 승인 (Accept All)
    'antigravity.terminalCommand.accept',    // 터미널 명령 승인 (alt+enter)
    'antigravity.command.accept',            // 일반 명령 승인 (ctrl+enter)
];

export class AutoAcceptService implements vscode.Disposable {
    private _enabled = false;
    private pollTimer: NodeJS.Timeout | null = null;
    
    // 상태 변경 이벤트
    private readonly _onStatusChange = new vscode.EventEmitter<boolean>();
    public readonly onStatusChange = this._onStatusChange.event;
    
    // 통계
    private stats = {
        acceptedSteps: 0,
    };

    get isEnabled(): boolean {
        return this._enabled;
    }

    /**
     * Auto-Accept 시작
     * CDP 불필요 - VS Code 명령어만 사용
     */
    async start(): Promise<void> {
        if (this._enabled) return;
        
        this._enabled = true;
        this._onStatusChange.fire(true);
        
        // 1초 인터벌 (500ms는 너무 공격적 → 프리징 유발)
        this.pollTimer = setInterval(() => {
            if (!this._enabled) return;
            this.poll(); // 비차단: await 안 함
        }, 1000);
        
        console.log('ReRevolve: Auto-Accept 활성화 (내부 명령어 방식)');
    }

    /**
     * Auto-Accept 중지
     */
    stop(): void {
        if (!this._enabled) return;
        
        this._enabled = false;
        this._onStatusChange.fire(false);
        
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        
        console.log('ReRevolve: Auto-Accept 비활성화');
    }

    /**
     * 토글
     */
    toggle(): boolean {
        if (this._enabled) {
            this.stop();
        } else {
            this.start();
        }
        return this._enabled;
    }

    /**
     * 폴링 - Accept 명령어 실행
     * pesosz 방식: 명령어가 없으면 조용히 실패 (에러 무시)
     */
    private poll(): void {
        // 각 명령어를 비차단으로 실행 (프리징 방지)
        for (const cmd of ACCEPT_COMMANDS) {
            vscode.commands.executeCommand(cmd).then(
                () => {},
                () => {} // 승인할 것이 없으면 조용히 무시
            );
        }
    }

    /**
     * 통계 반환
     */
    getStats(): { acceptedSteps: number } {
        return { ...this.stats };
    }

    /**
     * Disposable 구현
     */
    dispose(): void {
        this.stop();
        this._onStatusChange.dispose();
    }
}
