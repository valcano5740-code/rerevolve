/**
 * Account Switcher Service
 * state.vscdb의 antigravityAuthStatus를 수정하여 Antigravity 활성 계정 변경
 * 스냅샷을 globalState에 저장 (이식성 확보)
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { exec } from 'child_process';

// antigravityAuthStatus 전체 구조를 저장
interface AccountSnapshot {
    email: string;
    authStatus: string;  // antigravityAuthStatus 값 전체 (JSON 문자열)
    savedAt: number;
}

const SNAPSHOTS_KEY = 'rerevolve_snapshots';

export class AccountSwitcher implements vscode.Disposable {
    private dbPath: string;
    private globalState: vscode.Memento;
    private snapshotsCache: Record<string, AccountSnapshot> | null = null;

    constructor(context: vscode.ExtensionContext) {
        const appData = process.env.APPDATA || '';
        this.dbPath = path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        this.globalState = context.globalState;
    }

    dispose(): void {}

    /**
     * 현재 계정의 antigravityAuthStatus를 스냅샷으로 저장
     */
    async saveSnapshot(): Promise<boolean> {
        try {
            const authStatus = await this.readAuthStatus();
            if (!authStatus) {
                vscode.window.showWarningMessage('⚠️ 현재 로그인된 계정이 없습니다.');
                return false;
            }

            // JSON에서 이메일 추출
            let email = '';
            try {
                const parsed = JSON.parse(authStatus);
                email = parsed.email || parsed.name || 'unknown';
            } catch {
                email = 'unknown';
            }

            const snapshots = await this.loadSnapshots();
            snapshots[email] = {
                email,
                authStatus,
                savedAt: Date.now()
            };
            await this.saveSnapshots(snapshots);
            
            console.log(`ReRevolve: ${email} 스냅샷 저장됨 (globalState)`);
            vscode.window.showInformationMessage(`✅ ${email} 계정 스냅샷 저장됨`);
            return true;
        } catch (err) {
            console.error('ReRevolve: 스냅샷 저장 실패', err);
            vscode.window.showErrorMessage(`❌ 스냅샷 저장 실패: ${err}`);
            return false;
        }
    }

    /**
     * 스냅샷을 사용하여 계정 전환
     */
    async switchToAccount(email: string): Promise<boolean> {
        try {
            const snapshots = await this.loadSnapshots();
            const snapshot = snapshots[email];
            
            if (!snapshot) {
                vscode.window.showErrorMessage(`❌ ${email} 스냅샷이 없습니다.\n먼저 해당 계정으로 로그인 후 스냅샷을 저장하세요.`);
                return false;
            }

            // antigravityAuthStatus 값 교체
            const success = await this.updateAuthStatus(snapshot.authStatus);

            if (success) {
                const selection = await vscode.window.showInformationMessage(
                    `🔄 ${email}로 전환 완료! Reload Window를 실행하시겠습니까?`,
                    'Reload', '나중에'
                );
                if (selection === 'Reload') {
                    vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
                return true;
            }
            return false;
        } catch (err) {
            console.error('ReRevolve: 계정 전환 실패', err);
            vscode.window.showErrorMessage(`❌ 계정 전환 실패: ${err}`);
            return false;
        }
    }

    /**
     * 스냅샷 목록 조회
     */
    async getSnapshots(): Promise<Record<string, AccountSnapshot>> {
        return await this.loadSnapshots();
    }

    /**
     * 스냅샷 개수
     */
    async getSnapshotCount(): Promise<number> {
        const snapshots = await this.loadSnapshots();
        return Object.keys(snapshots).length;
    }

    /**
     * 스냅샷 삭제
     */
    async deleteSnapshot(email: string): Promise<boolean> {
        const snapshots = await this.loadSnapshots();
        if (snapshots[email]) {
            delete snapshots[email];
            await this.saveSnapshots(snapshots);
            vscode.window.showInformationMessage(`🗑️ ${email} 스냅샷 삭제됨`);
            return true;
        }
        return false;
    }

    // ==================== Private Methods ====================

    private async loadSnapshots(): Promise<Record<string, AccountSnapshot>> {
        // 캐시가 있으면 반환
        if (this.snapshotsCache !== null) {
            return this.snapshotsCache;
        }

        try {
            const data = this.globalState.get<string>(SNAPSHOTS_KEY);
            if (data) {
                this.snapshotsCache = JSON.parse(data);
                return this.snapshotsCache!;
            }
        } catch (err) {
            console.error('ReRevolve: 스냅샷 로드 실패', err);
        }
        this.snapshotsCache = {};
        return this.snapshotsCache;
    }

    private async saveSnapshots(snapshots: Record<string, AccountSnapshot>): Promise<void> {
        try {
            await this.globalState.update(SNAPSHOTS_KEY, JSON.stringify(snapshots));
            this.snapshotsCache = snapshots;
        } catch (err) {
            console.error('ReRevolve: 스냅샷 저장 실패', err);
        }
    }

    private readAuthStatus(): Promise<string | null> {
        return new Promise((resolve) => {
            const dbPathForward = this.dbPath.replace(/\\/g, '/');
            const cmd = `sqlite3 "${dbPathForward}" "SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'"`;

            exec(cmd, { maxBuffer: 1024 * 1024 }, (error, stdout) => {
                if (error) {
                    console.error('ReRevolve: DB 읽기 실패', error);
                    resolve(null);
                    return;
                }
                const value = stdout.trim();
                resolve(value || null);
            });
        });
    }

    private updateAuthStatus(authStatus: string): Promise<boolean> {
        return new Promise((resolve) => {
            const dbPathForward = this.dbPath.replace(/\\/g, '/');
            // SQL 인젝션 방지: 작은따옴표 이스케이프
            const escapedValue = authStatus.replace(/'/g, "''");
            const cmd = `sqlite3 "${dbPathForward}" "UPDATE ItemTable SET value='${escapedValue}' WHERE key='antigravityAuthStatus'"`;

            exec(cmd, (error) => {
                if (error) {
                    console.error('ReRevolve: DB 업데이트 실패', error);
                    resolve(false);
                    return;
                }
                console.log('ReRevolve: antigravityAuthStatus 업데이트 완료');
                resolve(true);
            });
        });
    }
}
