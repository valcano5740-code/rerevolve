/**
 * Account Manager - 계정 CRUD 관리
 * Atomic Write + globalState 이중 백업으로 비정상 종료 시에도 데이터 보존
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface Account {
    email: string;
    name: string;
    tier: 'free' | 'pro' | 'ultra';
    isPaid: boolean;
    isActive: boolean;
    refreshLocked: boolean;
    /** 사용자가 수동으로 잠금 해제한 경우 true — 자동 재잠금 방지 */
    manualUnlock?: boolean;
    createdAt: string;
    lastUpdated: string;
    /** 마지막 API resetTime 수신 시각 (epoch ms) — 로컬 카운트다운 기준점 */
    lastResetTimestamp?: number;
    /** 수신 당시 resetTime을 ms로 변환한 값 — 카운트다운 총 길이 */
    lastResetDurationMs?: number;
}

interface AccountsData {
    accounts: Account[];
    lastUpdated: string | null;
}

export class AccountManager {
    private dataPath: string;

    constructor(private context: vscode.ExtensionContext) {
        this.dataPath = path.join(context.globalStorageUri.fsPath, 'accounts.json');
        this.ensureDataDir();
    }

    private ensureDataDir(): void {
        const dir = path.dirname(this.dataPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * 파일 내용이 유효한 JSON인지 검증 (NULL 바이트 손상 감지 포함)
     */
    private tryReadAccountsFile(filePath: string): AccountsData | null {
        if (!fs.existsSync(filePath)) return null;
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            // NULL 바이트 손상 감지: 첫 10바이트가 모두 \0이면 손상된 파일
            if (raw.length > 0 && raw.substring(0, Math.min(10, raw.length)).replace(/\0/g, '').length === 0) {
                console.error(`ReRevolve: ${path.basename(filePath)} NULL 바이트 손상 감지 (${raw.length} bytes)`);
                return null;
            }
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
                return parsed;
            }
        } catch (err) {
            console.error(`ReRevolve: ${path.basename(filePath)} 파싱 실패`, err);
        }
        return null;
    }

    private load(): AccountsData {
        const empty: AccountsData = { accounts: [], lastUpdated: null };
        const bakPath = this.dataPath + '.bak';

        // 1. 메인 파일 읽기 시도
        const mainData = this.tryReadAccountsFile(this.dataPath);
        if (mainData) return mainData;

        // 2. .bak에서 복구 시도
        const bakData = this.tryReadAccountsFile(bakPath);
        if (bakData) {
            console.log(`ReRevolve: 백업에서 ${bakData.accounts.length}개 계정 자동 복구`);
            this.atomicWrite(this.dataPath, bakData);
            return bakData;
        }

        // 3. 파일+백업 모두 실패 → globalState에서 최종 복구
        try {
            const gsData = this.context.globalState.get<string>('rerevolve_accounts_backup');
            if (gsData) {
                const parsed = JSON.parse(gsData);
                if (parsed && Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
                    console.log(`ReRevolve: ✅ globalState에서 ${parsed.accounts.length}개 계정 최종 복구!`);
                    vscode.window.showWarningMessage(
                        `ReRevolve: accounts.json 손상 감지 → globalState에서 ${parsed.accounts.length}개 계정 복구됨`
                    );
                    this.atomicWrite(this.dataPath, parsed);
                    return parsed;
                }
            }
        } catch (err) {
            console.error('ReRevolve: globalState 복구도 실패', err);
        }

        return empty;
    }

    /**
     * Atomic Write: 임시 파일에 쓰고 → fsync → rename으로 원본 교체
     * 비정상 종료 시에도 원본 또는 백업 중 하나는 반드시 유효
     */
    private atomicWrite(targetPath: string, data: AccountsData): void {
        const tmpPath = targetPath + '.tmp';
        const content = JSON.stringify(data, null, 2);

        // 1. 임시 파일에 쓰기
        const fd = fs.openSync(tmpPath, 'w');
        fs.writeSync(fd, content);
        fs.fsyncSync(fd);  // 디스크에 확실히 플러시
        fs.closeSync(fd);

        // 2. 임시 파일 → 원본으로 교체 (atomic rename)
        fs.renameSync(tmpPath, targetPath);
    }

    private save(data: AccountsData): void {
        const bakPath = this.dataPath + '.bak';

        // 빈 배열 저장 시도 차단: 어디든 계정 데이터가 있으면 빈 배열로 덮어쓰지 않음
        if (data.accounts.length === 0) {
            const mainData = this.tryReadAccountsFile(this.dataPath);
            if (mainData) {
                console.warn(`ReRevolve: ⚠️ 빈 배열 저장 차단 (메인 파일에 ${mainData.accounts.length}개 계정 보존)`);
                return;
            }
            const bakData = this.tryReadAccountsFile(bakPath);
            if (bakData) {
                console.warn(`ReRevolve: ⚠️ 빈 배열 저장 차단 (백업에 ${bakData.accounts.length}개 계정 존재)`);
                return;
            }
        }

        data.lastUpdated = new Date().toISOString();

        // 1. 현재 유효한 원본 → .bak으로 안전하게 교체 (atomic)
        const currentData = this.tryReadAccountsFile(this.dataPath);
        if (currentData) {
            this.atomicWrite(bakPath, currentData);
        }

        // 2. 새 데이터 → 원본에 atomic write
        this.atomicWrite(this.dataPath, data);

        // 3. globalState에도 이중 백업 (비정상 종료 시 파일+.bak 동시 손상 대비)
        if (data.accounts.length > 0) {
            this.context.globalState.update('rerevolve_accounts_backup', JSON.stringify(data)).then(
                () => {},
                (err) => console.error('ReRevolve: globalState 백업 실패', err)
            );
        }
    }

    getAccounts(): Account[] {
        return this.load().accounts;
    }

    getAccount(email: string): Account | undefined {
        return this.load().accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
    }

    addAccount(email: string, name: string, tier: 'free' | 'pro' | 'ultra' = 'free'): boolean {
        const data = this.load();
        
        if (data.accounts.find(a => a.email.toLowerCase() === email.toLowerCase())) {
            vscode.window.showWarningMessage(`ReRevolve: 이미 등록된 계정입니다: ${email}`);
            return false;
        }

        const account: Account = {
            email,
            name,
            tier,
            isPaid: tier !== 'free',
            isActive: false,
            refreshLocked: false,
            createdAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString()
        };

        data.accounts.push(account);
        this.save(data);
        
        vscode.window.showInformationMessage(`ReRevolve: 계정 추가됨 - ${name} (${email})`);
        return true;
    }

    updateAccount(email: string, updates: Partial<Account>): boolean {
        const data = this.load();
        const index = data.accounts.findIndex(a => a.email.toLowerCase() === email.toLowerCase());
        
        if (index === -1) {
            return false;
        }

        data.accounts[index] = { ...data.accounts[index], ...updates, lastUpdated: new Date().toISOString() };
        this.save(data);
        return true;
    }

    removeAccount(email: string): boolean {
        const data = this.load();
        const initialLength = data.accounts.length;
        data.accounts = data.accounts.filter(a => a.email.toLowerCase() !== email.toLowerCase());
        
        if (data.accounts.length < initialLength) {
            this.save(data);
            vscode.window.showInformationMessage(`ReRevolve: 계정 삭제됨 - ${email}`);
            return true;
        }
        return false;
    }

    setActiveAccount(email: string): void {
        const data = this.load();
        data.accounts.forEach(a => {
            a.isActive = a.email.toLowerCase() === email.toLowerCase();
        });
        this.save(data);
    }

    lockRefresh(email: string, locked: boolean): void {
        this.updateAccount(email, { refreshLocked: locked });
    }

    /**
     * 계정 순서 변경
     */
    reorderAccounts(newOrder: string[]): void {
        const data = this.load();
        const reordered: Account[] = [];
        
        for (const email of newOrder) {
            const account = data.accounts.find(a => a.email.toLowerCase() === email.toLowerCase());
            if (account) {
                reordered.push(account);
            }
        }
        
        // 순서에 없는 계정은 뒤에 추가
        for (const account of data.accounts) {
            if (!reordered.find(a => a.email.toLowerCase() === account.email.toLowerCase())) {
                reordered.push(account);
            }
        }
        
        data.accounts = reordered;
        this.save(data);
    }

    /**
     * 활성 계정을 상단에 두고 정렬된 계정 목록 반환
     */
    getAccountsSorted(): Account[] {
        const accounts = this.load().accounts;
        
        // 활성 계정을 맨 앞으로
        return accounts.sort((a, b) => {
            if (a.isActive && !b.isActive) return -1;
            if (!a.isActive && b.isActive) return 1;
            return 0;
        });
    }
}
