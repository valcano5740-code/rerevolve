/**
 * Account Manager - 계정 CRUD 관리
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface Account {
    email: string;
    name: string;
    tier: 'free' | 'pro' | 'ultra';
    isPaid: boolean;
    isActive: boolean;
    refreshLocked: boolean;
    createdAt: string;
    lastUpdated: string;
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

    private load(): AccountsData {
        const empty: AccountsData = { accounts: [], lastUpdated: null };
        const bakPath = this.dataPath + '.bak';

        // 1. 메인 파일 읽기 시도
        if (fs.existsSync(this.dataPath)) {
            try {
                const raw = fs.readFileSync(this.dataPath, 'utf-8');
                const parsed = JSON.parse(raw);
                if (parsed && Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
                    return parsed;
                }
            } catch (err) {
                console.error('ReRevolve: accounts.json 파싱 실패', err);
            }
        }

        // 2. 메인 파일이 없거나 빈 배열이면 → .bak에서 복구
        if (fs.existsSync(bakPath)) {
            try {
                const bakData = JSON.parse(fs.readFileSync(bakPath, 'utf-8'));
                if (bakData && Array.isArray(bakData.accounts) && bakData.accounts.length > 0) {
                    console.log(`ReRevolve: 백업에서 ${bakData.accounts.length}개 계정 자동 복구`);
                    // 메인 파일에 복원
                    fs.writeFileSync(this.dataPath, JSON.stringify(bakData, null, 2));
                    return bakData;
                }
            } catch {
                console.error('ReRevolve: 백업 파일도 파싱 실패');
            }
        }

        return empty;
    }

    private save(data: AccountsData): void {
        const bakPath = this.dataPath + '.bak';

        // 빈 배열 저장 시도 차단: .bak 포함 어디든 계정 데이터가 있으면 절대 빈 배열로 덮어쓰기 않음
        if (data.accounts.length === 0) {
            // 메인 파일 체크
            if (fs.existsSync(this.dataPath)) {
                try {
                    const existing = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
                    if (existing.accounts && existing.accounts.length > 0) {
                        console.warn(`ReRevolve: ⚠️ 빈 배열 저장 차단 (메인 파일에 ${existing.accounts.length}개 계정 보존)`);
                        return;
                    }
                } catch { /* ignore */ }
            }
            // .bak 파일 체크
            if (fs.existsSync(bakPath)) {
                try {
                    const bakData = JSON.parse(fs.readFileSync(bakPath, 'utf-8'));
                    if (bakData.accounts && bakData.accounts.length > 0) {
                        console.warn(`ReRevolve: ⚠️ 빈 배열 저장 차단 (백업에 ${bakData.accounts.length}개 계정 존재)`);
                        return;
                    }
                } catch { /* ignore */ }
            }
        }

        // 저장 전 백업 생성 (현재 파일에 계정이 있을 때만)
        if (fs.existsSync(this.dataPath)) {
            try {
                const current = fs.readFileSync(this.dataPath, 'utf-8');
                const parsed = JSON.parse(current);
                if (parsed.accounts && parsed.accounts.length > 0) {
                    fs.writeFileSync(bakPath, current);
                }
            } catch { /* ignore */ }
        }

        data.lastUpdated = new Date().toISOString();
        fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
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
