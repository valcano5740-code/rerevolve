/**
 * Account Switcher Service
 * state.vscdb의 antigravityAuthStatus를 수정하여 Antigravity 활성 계정 변경
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';

// antigravityAuthStatus 전체 구조를 저장
interface AccountSnapshot {
    email: string;
    authStatus: string;  // antigravityAuthStatus 값 전체 (JSON 문자열)
    savedAt: number;
}

export class AccountSwitcher implements vscode.Disposable {
    private dbPath: string;
    private snapshotsPath: string;

    constructor(context: vscode.ExtensionContext) {
        const appData = process.env.APPDATA || '';
        this.dbPath = path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        this.snapshotsPath = path.join(appData, 'Antigravity', 'User', 'globalStorage', 'rerevolve-snapshots.json');
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

            const snapshots = this.loadSnapshots();
            snapshots[email] = {
                email,
                authStatus,
                savedAt: Date.now()
            };
            this.saveSnapshots(snapshots);
            
            console.log(`ReRevolve: ${email} 스냅샷 저장됨`);
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
            const snapshots = this.loadSnapshots();
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
    getSnapshots(): Record<string, AccountSnapshot> {
        return this.loadSnapshots();
    }

    /**
     * 스냅샷 개수
     */
    getSnapshotCount(): number {
        return Object.keys(this.loadSnapshots()).length;
    }

    /**
     * 스냅샷 삭제
     */
    deleteSnapshot(email: string): boolean {
        const snapshots = this.loadSnapshots();
        if (snapshots[email]) {
            delete snapshots[email];
            this.saveSnapshots(snapshots);
            vscode.window.showInformationMessage(`🗑️ ${email} 스냅샷 삭제됨`);
            return true;
        }
        return false;
    }

    // ==================== Private Methods ====================

    private loadSnapshots(): Record<string, AccountSnapshot> {
        try {
            if (fs.existsSync(this.snapshotsPath)) {
                const data = fs.readFileSync(this.snapshotsPath, 'utf8');
                return JSON.parse(data);
            }
        } catch (err) {
            console.error('ReRevolve: 스냅샷 로드 실패', err);
        }
        return {};
    }

    private saveSnapshots(snapshots: Record<string, AccountSnapshot>): void {
        try {
            fs.writeFileSync(this.snapshotsPath, JSON.stringify(snapshots, null, 2), 'utf8');
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
