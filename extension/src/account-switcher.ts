/**
 * Account Switcher Service v2
 * state.vscdb의 antigravityAuthStatus를 수정하여 Antigravity 활성 계정 변경
 * 
 * v2 변경점:
 * - sqlite3 CLI 의존성 제거 → sql.js 인-프로세스 사용 (DB 잠금 방지)
 * - 이메일 추출 로직 강화 (email > name 폴백)
 * - DB read/write를 파일 버퍼로 처리 (WAL 잠금 회피)
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { StoredCredential, TokenService } from './token-service';
import { readValueDirect, readBase64ValueDirect, readJsonFieldsDirect } from './direct-db-reader';

const execAsync = promisify(exec);

// sql.js 지연 로딩 (쓰기 작업 시에만 초기화 - 기동 시 WASM 블로킹 방지)
let sqlJsLazyPromise: Promise<any> | null = null;

async function getSqlJsLazy(): Promise<any> {
    if (!sqlJsLazyPromise) {
        sqlJsLazyPromise = (async () => {
            const initSqlJs = require('sql.js');
            return await initSqlJs();
        })();
    }
    return sqlJsLazyPromise;
}

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

    constructor(context: vscode.ExtensionContext, private tokenService?: TokenService) {
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
            const email = this.extractEmail(authStatus);
            if (email === 'unknown') {
                vscode.window.showWarningMessage('⚠️ 계정 이메일을 추출할 수 없습니다.');
                return false;
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
            const tokenSwitchResult = await this.switchWithStoredCredential(email);
            if (tokenSwitchResult !== null) {
                return tokenSwitchResult;
            }

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
     * 저장된 refresh token 기반 실제 계정 전환.
     * Antigravity 1.23+는 antigravityAuthStatus만 바꾸면 LS가 다시 원래 계정으로 덮어쓴다.
     * 따라서 oauthToken 통합 상태까지 새 access token으로 교체하고 LS를 재시작한다.
     */
    private async switchWithStoredCredential(email: string): Promise<boolean | null> {
        if (!this.tokenService) {
            return null;
        }

        const normalizedEmail = email.toLowerCase();
        const credential = await this.tokenService.getCredentialForSwitch(normalizedEmail);
        if (!credential || !credential.accessToken) {
            return null;
        }

        const snapshots = await this.loadSnapshots();
        const snapshot = snapshots[normalizedEmail];
        const snapshotAuth = snapshot ? this.parseAuthStatus(snapshot.authStatus) : null;
        const userInfo = await this.fetchGoogleUserInfo(credential.accessToken);
        const displayName = userInfo?.name || snapshotAuth?.name || normalizedEmail.split('@')[0];
        const userStatusProto = snapshotAuth?.userStatusProtoBinaryBase64;

        const currentOAuthState = readBase64ValueDirect(this.dbPath, 'antigravityUnifiedStateSync.oauthToken');
        const currentAgentManagerState = readBase64ValueDirect(this.dbPath, 'jetskiStateSync.agentManagerInitState');
        const authStatus = JSON.stringify({
            name: displayName,
            apiKey: credential.accessToken,
            email: normalizedEmail,
            ...(userStatusProto ? { userStatusProtoBinaryBase64: userStatusProto } : {})
        });

        const updates: Record<string, string | undefined> = {
            antigravityAuthStatus: authStatus,
            'antigravityUnifiedStateSync.oauthToken': this.buildOAuthStateValue(credential, currentOAuthState)
        };

        const agentManagerState = this.buildAgentManagerStateValue(credential, currentAgentManagerState);
        if (agentManagerState) {
            updates['jetskiStateSync.agentManagerInitState'] = agentManagerState;
        }

        if (userStatusProto) {
            updates['antigravityUnifiedStateSync.userStatus'] = this.buildSingleSyncStateValue(
                'userStatusSentinelKey',
                userStatusProto
            );
        }

        const success = await this.updateStateValues(updates);
        if (!success) {
            return false;
        }

        this.tokenService.invalidateCache();
        await this.stopLanguageServers();
        vscode.window.showInformationMessage(`✅ ${normalizedEmail}로 계정 전환 상태를 적용했습니다. Antigravity를 다시 불러옵니다.`);
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
        return true;
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

    /**
     * 현재 활성 계정 이메일 조회 (스냅샷 없이도)
     */
    async getCurrentAccountEmail(): Promise<string | null> {
        try {
            const authStatus = await this.readAuthStatus();
            if (!authStatus) return null;
            const email = this.extractEmail(authStatus);
            return email !== 'unknown' ? email : null;
        } catch {
            return null;
        }
    }

    // ==================== Private Methods ====================

    /**
     * authStatus JSON에서 이메일 추출
     * 실제 구조: {"name":"김서연","apiKey":"ya29...","email":"tjdus5740@gmail.com","userStatusProtoBinaryBase64":"..."}
     */
    private extractEmail(authStatus: string): string {
        try {
            const parsed = JSON.parse(authStatus);
            // email 필드 우선, name 폴백
            if (parsed.email && parsed.email.includes('@')) {
                return parsed.email;
            }
            // name이 이메일 형식이면 사용
            if (parsed.name && parsed.name.includes('@')) {
                return parsed.name;
            }
            // 둘 다 아니면 name 반환 (표시이름)
            return parsed.name || 'unknown';
        } catch {
            return 'unknown';
        }
    }

    private parseAuthStatus(authStatus: string): any | null {
        try {
            return JSON.parse(authStatus);
        } catch {
            return null;
        }
    }

    private async fetchGoogleUserInfo(accessToken: string): Promise<{ email?: string; name?: string } | null> {
        try {
            const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            if (!response.ok) return null;
            return await response.json() as { email?: string; name?: string };
        } catch {
            return null;
        }
    }

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

    private readDbValueDirect(key: string): string | null {
        try {
            if (!fs.existsSync(this.dbPath)) return null;
            // JSON 형태 시도
            const jsonValue = readValueDirect(this.dbPath, key);
            if (jsonValue) return jsonValue;
            // Base64 형태 시도
            const b64Value = readBase64ValueDirect(this.dbPath, key);
            if (b64Value) return b64Value;
        } catch (err) {
            console.error(`ReRevolve: DB 값 읽기 실패 (${key})`, err);
        }
        return null;
    }

    /**
     * state.vscdb에서 antigravityAuthStatus 읽기 (sql.js 인-프로세스)
     * 파일을 메모리로 복사해서 읽으므로 WAL 잠금 충돌 없음
     */
    private async readAuthStatus(): Promise<string | null> {
        try {
            if (!fs.existsSync(this.dbPath)) {
                console.error(`ReRevolve: DB 파일 없음: ${this.dbPath}`);
                return null;
            }
            // 직접 버퍼 스캔으로 antigravityAuthStatus 값 추출
            const value = readValueDirect(this.dbPath, 'antigravityAuthStatus');
            return value;
        } catch (err) {
            console.error('ReRevolve: DB 읽기 실패 (direct)', err);
            return null;
        }
    }

    /**
     * state.vscdb에 antigravityAuthStatus 쓰기 (sql.js 인-프로세스)
     * 
     * 주의: IDE가 DB를 동시에 사용 중이므로,
     * DB를 읽기 → 메모리에서 수정 → 전체 파일 다시 쓰기 방식 사용.
     * WAL 모드 충돌 방지를 위해 재시도 로직 포함.
     */
    private async updateAuthStatus(authStatus: string): Promise<boolean> {
        return this.updateStateValues({ antigravityAuthStatus: authStatus });
    }

    private async updateStateValues(values: Record<string, string | undefined>): Promise<boolean> {
        const MAX_RETRIES = 3;
        const RETRY_DELAY = 500;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            let db: any;
            try {
                if (!fs.existsSync(this.dbPath)) {
                    console.error(`ReRevolve: DB 파일 없음: ${this.dbPath}`);
                    return false;
                }

                // sql.js 지연 로딩 (쓰기 시에만 WASM 초기화)
                const SQL = await getSqlJsLazy();
                const fileBuffer = fs.readFileSync(this.dbPath);
                db = new SQL.Database(fileBuffer);

                for (const [key, value] of Object.entries(values)) {
                    if (value === undefined) {
                        db.run('DELETE FROM ItemTable WHERE key = ?', [key]);
                    } else {
                        db.run(
                            'INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)',
                            [key, value]
                        );
                    }
                }

                // 수정된 DB를 파일로 다시 쓰기
                const modifiedData = db.export();
                const buffer = Buffer.from(modifiedData);
                fs.writeFileSync(this.dbPath, buffer);

                console.log(`ReRevolve: 상태 DB 업데이트 완료 (${Object.keys(values).join(', ')})`);
                return true;
            } catch (err) {
                console.error(`ReRevolve: DB 업데이트 시도 ${attempt}/${MAX_RETRIES} 실패:`, err);
                if (attempt < MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, RETRY_DELAY));
                }
            } finally {
                if (db) { try { db.close(); } catch {} }
            }
        }

        vscode.window.showErrorMessage('❌ DB 업데이트 실패: 여러 번 시도했으나 실패했습니다. IDE를 닫고 다시 시도하세요.');
        return false;
    }

    private writeVarint(value: number): Buffer {
        const bytes: number[] = [];
        let current = Math.floor(value);
        while (current > 127) {
            bytes.push((current & 0x7f) | 0x80);
            current = Math.floor(current / 128);
        }
        bytes.push(current);
        return Buffer.from(bytes);
    }

    private protoBytes(fieldNumber: number, value: Buffer | string): Buffer {
        const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
        return Buffer.concat([
            this.writeVarint((fieldNumber << 3) | 2),
            this.writeVarint(body.length),
            body
        ]);
    }

    private protoVarint(fieldNumber: number, value: number): Buffer {
        return Buffer.concat([
            this.writeVarint((fieldNumber << 3) | 0),
            this.writeVarint(value)
        ]);
    }

    private encodeOAuthTokenInfo(credential: StoredCredential): Buffer {
        const expiresSeconds = Math.max(0, Math.floor(credential.expiresAt / 1000));
        const fields = [
            this.protoBytes(1, credential.accessToken),
            this.protoBytes(2, 'Bearer'),
            credential.refreshToken ? this.protoBytes(3, credential.refreshToken) : Buffer.alloc(0),
            this.protoBytes(4, this.protoVarint(1, expiresSeconds))
        ];
        return Buffer.concat(fields);
    }

    private encodeSyncEntry(key: string, value: string): Buffer {
        const entry = Buffer.concat([
            this.protoBytes(1, key),
            this.protoBytes(2, this.protoBytes(1, value))
        ]);
        return this.protoBytes(1, entry);
    }

    private buildSingleSyncStateValue(key: string, value: string): string {
        return this.encodeSyncEntry(key, value).toString('base64');
    }

    private buildOAuthStateValue(credential: StoredCredential, existingBase64: string | null): string {
        const oauthTokenInfo = this.encodeOAuthTokenInfo(credential).toString('base64');
        const replacement = this.encodeSyncEntry('oauthTokenInfoSentinelKey', oauthTokenInfo);
        const entries = existingBase64 ? this.parseSyncEntries(Buffer.from(existingBase64, 'base64')) : [];
        let replaced = false;
        const nextEntries = entries.map(entry => {
            if (entry.key === 'oauthTokenInfoSentinelKey') {
                replaced = true;
                return replacement;
            }
            return entry.raw;
        });

        if (!entries.some(entry => entry.key === 'authStateWithContextSentinelKey')) {
            nextEntries.unshift(this.encodeSyncEntry(
                'authStateWithContextSentinelKey',
                JSON.stringify({ state: 'signedIn', context: { project: '', showProjectError: false, errorMessage: '' } })
            ));
        }
        if (!replaced) {
            nextEntries.push(replacement);
        }

        return Buffer.concat(nextEntries).toString('base64');
    }

    private buildAgentManagerStateValue(credential: StoredCredential, existingBase64: string | null): string | undefined {
        if (!existingBase64) {
            return undefined;
        }

        try {
            const existing = Buffer.from(existingBase64, 'base64');
            const oauthTokenInfo = this.encodeOAuthTokenInfo(credential);
            const replaced = this.replaceTopLevelLengthDelimitedField(existing, 6, oauthTokenInfo);
            return replaced.toString('base64');
        } catch (err) {
            console.error('ReRevolve: jetski agentManagerInitState OAuth 교체 실패', err);
            return undefined;
        }
    }

    private replaceTopLevelLengthDelimitedField(raw: Buffer, targetFieldNumber: number, replacementBody: Buffer): Buffer {
        const chunks: Buffer[] = [];
        let offset = 0;
        let replaced = false;

        while (offset < raw.length) {
            const start = offset;
            const [tag, tagOffset] = this.readVarint(raw, offset);
            const wireType = tag & 7;
            const fieldNumber = tag >> 3;
            const end = this.skipField(raw, tagOffset, wireType);

            if (fieldNumber === targetFieldNumber && wireType === 2) {
                chunks.push(this.protoBytes(targetFieldNumber, replacementBody));
                replaced = true;
            } else {
                chunks.push(raw.subarray(start, end));
            }

            offset = end;
        }

        if (!replaced) {
            chunks.push(this.protoBytes(targetFieldNumber, replacementBody));
        }

        return Buffer.concat(chunks);
    }

    private skipField(data: Buffer, offset: number, wireType: number): number {
        if (wireType === 0) {
            return this.readVarint(data, offset)[1];
        }
        if (wireType === 1) {
            return offset + 8;
        }
        if (wireType === 2) {
            const [length, contentOffset] = this.readVarint(data, offset);
            return contentOffset + length;
        }
        if (wireType === 5) {
            return offset + 4;
        }
        throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }

    private parseSyncEntries(raw: Buffer): Array<{ key: string; raw: Buffer }> {
        const entries: Array<{ key: string; raw: Buffer }> = [];
        let offset = 0;
        while (offset < raw.length) {
            const start = offset;
            const [tag, tagOffset] = this.readVarint(raw, offset);
            const wireType = tag & 7;
            const fieldNumber = tag >> 3;
            if (fieldNumber !== 1 || wireType !== 2) break;

            const [length, contentOffset] = this.readVarint(raw, tagOffset);
            const end = contentOffset + length;
            const entryBody = raw.subarray(contentOffset, end);
            const key = this.extractSyncEntryKey(entryBody);
            entries.push({ key, raw: raw.subarray(start, end) });
            offset = end;
        }
        return entries;
    }

    private extractSyncEntryKey(entryBody: Buffer): string {
        let offset = 0;
        while (offset < entryBody.length) {
            const [tag, tagOffset] = this.readVarint(entryBody, offset);
            const wireType = tag & 7;
            const fieldNumber = tag >> 3;
            if (wireType !== 2) break;
            const [length, contentOffset] = this.readVarint(entryBody, tagOffset);
            const value = entryBody.subarray(contentOffset, contentOffset + length);
            if (fieldNumber === 1) return value.toString('utf8');
            offset = contentOffset + length;
        }
        return '';
    }

    private readVarint(data: Buffer, offset: number): [number, number] {
        let result = 0;
        let shift = 0;
        let pos = offset;
        while (pos < data.length) {
            const byte = data[pos];
            result += (byte & 0x7f) * Math.pow(2, shift);
            pos += 1;
            if ((byte & 0x80) === 0) return [result, pos];
            shift += 7;
        }
        throw new Error('Incomplete varint');
    }

    private async stopLanguageServers(): Promise<void> {
        if (process.platform !== 'win32') return;
        try {
            await execAsync(
                `Get-Process language_server_windows_x64 -ErrorAction SilentlyContinue | Stop-Process -Force`,
                { shell: 'powershell.exe', timeout: 10000 }
            );
            console.log('ReRevolve: Language Server 프로세스 재시작을 위해 종료 완료');
        } catch (err) {
            console.log('ReRevolve: Language Server 종료 스킵/실패', err);
        }
    }
}
