/**
 * Token Service - Antigravity 토큰 추출 및 관리
 * state.vscdb에서 ya29 토큰 추출, SecretStorage에 저장
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import initSqlJs, { Database } from 'sql.js';

const TOKEN_PREFIX = 'rerevolve.token.';
const STATE_KEY = 'jetskiStateSync.agentManagerInitState';

// sql.js 초기화 캐시
let sqlJsPromise: ReturnType<typeof initSqlJs> | null = null;

async function getSqlJs(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
    if (!sqlJsPromise) {
        sqlJsPromise = initSqlJs();
    }
    return sqlJsPromise;
}

// Antigravity OAuth 클라이언트 자격증명
// .credentials.json 파일 또는 환경변수에서 로드
const credentialsPath = path.join(__dirname, '..', '.credentials.json');
let ANTIGRAVITY_CLIENT_ID = '';
let ANTIGRAVITY_CLIENT_SECRET = '';
try {
    const creds = require(credentialsPath);
    ANTIGRAVITY_CLIENT_ID = creds.clientId || process.env.ANTIGRAVITY_CLIENT_ID || '';
    ANTIGRAVITY_CLIENT_SECRET = creds.clientSecret || process.env.ANTIGRAVITY_CLIENT_SECRET || '';
} catch {
    ANTIGRAVITY_CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID || '';
    ANTIGRAVITY_CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET || '';
}

interface StoredCredential {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    email: string;
    createdAt: number;
}

export class TokenService {
    private cachedToken: string | null = null;
    private tokenExpiry: Date | null = null;

    constructor(private secrets: vscode.SecretStorage) {}

    /**
     * state.vscdb 경로 가져오기
     */
    private getStateDbPath(): string {
        const homeDir = os.homedir();
        if (process.platform === 'win32') {
            const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
            return path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        }
        if (process.platform === 'darwin') {
            return path.join(homeDir, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
        }
        return path.join(homeDir, '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
    }

    /**
     * antigravityAuthStatus에서 현재 계정 정보 읽기 (가장 신뢰할 수 있음)
     */
    private async getAuthStatus(): Promise<{ email?: string; apiKey?: string } | null> {
        const dbPath = this.getStateDbPath();
        if (!fs.existsSync(dbPath)) {
            return null;
        }

        try {
            const SQL = await getSqlJs();
            const fileBuffer = fs.readFileSync(dbPath);
            let db: Database | null = null;

            try {
                db = new SQL.Database(fileBuffer);
                const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
                stmt.bind(['antigravityAuthStatus']);

                if (stmt.step()) {
                    const row = stmt.get();
                    stmt.free();
                    if (row && row[0]) {
                        const json = JSON.parse(String(row[0]));
                        return {
                            email: json.email,
                            apiKey: json.apiKey
                        };
                    }
                } else {
                    stmt.free();
                }
            } finally {
                if (db) {
                    db.close();
                }
            }
        } catch (err) {
            console.error('ReRevolve: Failed to read authStatus', err);
        }

        return null;
    }

    /**
     * antigravityUnifiedStateSync.oauthToken에서 refresh token 추출
     * (현재 로그인 계정의 토큰 - jetskiStateSync보다 신뢰할 수 있음)
     */
    private async getRefreshToken(): Promise<string | null> {
        const dbPath = this.getStateDbPath();
        if (!fs.existsSync(dbPath)) {
            return null;
        }

        try {
            const SQL = await getSqlJs();
            const fileBuffer = fs.readFileSync(dbPath);
            let db: Database | null = null;

            try {
                db = new SQL.Database(fileBuffer);
                const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
                stmt.bind(['antigravityUnifiedStateSync.oauthToken']);

                if (stmt.step()) {
                    const row = stmt.get();
                    stmt.free();
                    if (row && row[0]) {
                        const base64Value = String(row[0]).trim();
                        const raw = Buffer.from(base64Value, 'base64');
                        
                        // Protobuf에서 refresh token 추출 (field 3)
                        const oauthField = this.findField(raw, 1); // oauthTokenInfo는 field 1
                        if (oauthField) {
                            const tokenInfo = this.parseOAuthTokenInfo(oauthField);
                            if (tokenInfo.refreshToken) {
                                console.log(`ReRevolve: Refresh token from oauthToken: ${tokenInfo.refreshToken.substring(0, 15)}...`);
                                return tokenInfo.refreshToken;
                            }
                        }
                    }
                } else {
                    stmt.free();
                }
            } finally {
                if (db) {
                    db.close();
                }
            }
        } catch (err) {
            console.error('ReRevolve: Failed to read refresh token', err);
        }

        return null;
    }

    // ========== Protobuf 파싱 함수들 (Cockpit 방식) ==========
    
    /**
     * SQLite에서 상태값 읽기
     */
    private async readStateValue(): Promise<string | null> {
        const dbPath = this.getStateDbPath();
        if (!fs.existsSync(dbPath)) {
            console.log('ReRevolve: state.vscdb not found');
            return null;
        }

        try {
            const SQL = await getSqlJs();
            const fileBuffer = fs.readFileSync(dbPath);
            let db: Database | null = null;

            try {
                db = new SQL.Database(fileBuffer);
                const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
                stmt.bind([STATE_KEY]);

                if (stmt.step()) {
                    const row = stmt.get();
                    stmt.free();
                    if (row && row[0]) {
                        const value = String(row[0]).trim();
                        if (value.length > 0) {
                            return value;
                        }
                    }
                } else {
                    stmt.free();
                }
            } finally {
                if (db) {
                    db.close();
                }
            }
        } catch (err) {
            console.error('ReRevolve: Failed to read state.vscdb', err);
        }

        return null;
    }

    /**
     * Protobuf varint 읽기
     */
    private readVarint(data: Buffer, offset: number): [number, number] {
        let result = 0;
        let shift = 0;
        let pos = offset;
        while (pos < data.length) {
            const byte = data[pos];
            result += (byte & 0x7f) * Math.pow(2, shift);
            pos += 1;
            if ((byte & 0x80) === 0) {
                return [result, pos];
            }
            shift += 7;
        }
        throw new Error('Incomplete varint');
    }

    /**
     * Protobuf 필드 건너뛰기
     */
    private skipField(data: Buffer, offset: number, wireType: number): number {
        if (wireType === 0) {
            const [, newOffset] = this.readVarint(data, offset);
            return newOffset;
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
        throw new Error(`Unknown wire type: ${wireType}`);
    }

    /**
     * Protobuf에서 특정 필드 찾기
     */
    private findField(data: Buffer, targetField: number): Buffer | undefined {
        let offset = 0;
        while (offset < data.length) {
            let tag = 0;
            let newOffset = 0;
            try {
                [tag, newOffset] = this.readVarint(data, offset);
            } catch {
                break;
            }
            const wireType = tag & 7;
            const fieldNum = tag >> 3;
            if (fieldNum === targetField && wireType === 2) {
                const [length, contentOffset] = this.readVarint(data, newOffset);
                return data.subarray(contentOffset, contentOffset + length);
            }
            offset = this.skipField(data, newOffset, wireType);
        }
        return undefined;
    }

    /**
     * OAuth 토큰 정보 파싱 (field 1=accessToken, 3=refreshToken)
     */
    private parseOAuthTokenInfo(data: Buffer): { accessToken?: string; refreshToken?: string } {
        let offset = 0;
        const info: { accessToken?: string; refreshToken?: string } = {};

        while (offset < data.length) {
            try {
                const [tag, newOffset] = this.readVarint(data, offset);
                const wireType = tag & 7;
                const fieldNum = tag >> 3;
                offset = newOffset;

                if (wireType === 2) {
                    const [length, contentOffset] = this.readVarint(data, offset);
                    const value = data.subarray(contentOffset, contentOffset + length);
                    offset = contentOffset + length;

                    if (fieldNum === 1) {
                        info.accessToken = value.toString();
                    } else if (fieldNum === 3) {
                        info.refreshToken = value.toString();
                    }
                    continue;
                }
                offset = this.skipField(data, offset, wireType);
            } catch {
                break;
            }
        }

        return info;
    }

    /**
     * Protobuf 기반 토큰 추출 (Cockpit 방식)
     */
    async extractTokensWithProtobuf(): Promise<{ accessToken?: string; refreshToken?: string } | null> {
        try {
            const stateValue = await this.readStateValue();
            if (!stateValue) {
                console.log('ReRevolve: No state value found in SQLite');
                return null;
            }

            const raw = Buffer.from(stateValue.trim(), 'base64');
            
            // OAuth 필드는 field 6에 있음
            const oauthField = this.findField(raw, 6);
            if (!oauthField) {
                console.log('ReRevolve: OAuth field not found in protobuf');
                return null;
            }

            const tokenInfo = this.parseOAuthTokenInfo(oauthField);
            
            if (tokenInfo.refreshToken) {
                console.log(`ReRevolve: Protobuf extraction successful! refreshToken: ${tokenInfo.refreshToken.substring(0, 15)}...`);
            }
            if (tokenInfo.accessToken) {
                console.log(`ReRevolve: Protobuf extraction - accessToken found`);
            }

            return tokenInfo;
        } catch (err) {
            console.error('ReRevolve: Protobuf extraction failed', err);
            return null;
        }
    }

    /**
     * 파일에서 직접 ya29 토큰과 리프레시 토큰 추출 (SQLite 라이브러리 없이)
     */
    async extractTokensFromDb(): Promise<{ accessToken: string; refreshToken?: string } | null> {
        const dbPath = this.getStateDbPath();
        
        if (!fs.existsSync(dbPath)) {
            console.log('ReRevolve: state.vscdb not found at', dbPath);
            return null;
        }

        try {
            const fileBuffer = fs.readFileSync(dbPath);
            const content = fileBuffer.toString('utf8');

            // 액세스 토큰 수집 (위치순)
            const allTokens: { index: number; token: string }[] = [];

            // Base64 인코딩된 ya29 토큰 찾기 (eWEyOS = ya29 in base64)
            const base64Regex = /eWEyOS[a-zA-Z0-9+/=_-]{50,300}/g;
            let match;
            while ((match = base64Regex.exec(content)) !== null) {
                try {
                    const decoded = Buffer.from(match[0], 'base64').toString('utf8');
                    const tokenMatch = decoded.match(/ya29\.[a-zA-Z0-9_-]+/);
                    if (tokenMatch && tokenMatch[0].length > 100) {
                        allTokens.push({ index: match.index, token: tokenMatch[0] });
                    }
                } catch {
                    // decode 실패, 다음 시도
                }
            }

            // 직접 ya29 패턴 검색
            const directRegex = /ya29\.[a-zA-Z0-9_-]{100,}/g;
            while ((match = directRegex.exec(content)) !== null) {
                allTokens.push({ index: match.index, token: match[0] });
            }

            // 리프레시 토큰 추출 (다양한 패턴 시도)
            let refreshToken: string | undefined;
            const refreshTokens: { index: number; token: string }[] = [];
            
            // 패턴 1: 1/xxx (일반적인 형태)
            const refreshRegex1 = /1\/[a-zA-Z0-9_-]{40,150}/g;
            while ((match = refreshRegex1.exec(content)) !== null) {
                refreshTokens.push({ index: match.index, token: match[0] });
            }
            
            // 패턴 2: 1//xxx (더블 슬래시 형태)
            const refreshRegex2 = /1\/\/[a-zA-Z0-9_-]{30,150}/g;
            while ((match = refreshRegex2.exec(content)) !== null) {
                refreshTokens.push({ index: match.index, token: match[0] });
            }
            
            // 패턴 3: "refresh_token":"xxx" 형태
            const refreshRegex3 = /"refresh_token"\s*:\s*"([^"]{30,200})"/g;
            while ((match = refreshRegex3.exec(content)) !== null) {
                refreshTokens.push({ index: match.index, token: match[1] });
            }
            
            if (refreshTokens.length > 0) {
                refreshTokens.sort((a, b) => a.index - b.index);
                refreshToken = refreshTokens[refreshTokens.length - 1].token;
                console.log(`ReRevolve: Refresh token extracted (${refreshTokens.length} found, last: ${refreshToken.substring(0, 15)}...)`);
            } else {
                console.log('ReRevolve: No refresh token found in state.vscdb');
            }

            // 파일 내 위치순으로 정렬 후 가장 마지막(최신) 토큰 사용
            if (allTokens.length > 0) {
                allTokens.sort((a, b) => a.index - b.index);
                const lastToken = allTokens[allTokens.length - 1];
                console.log(`ReRevolve: Access token extracted (${allTokens.length} found)`);
                return { accessToken: lastToken.token, refreshToken };
            }

            console.log('ReRevolve: No token pattern found in file');
        } catch (err) {
            console.error('ReRevolve: Token extraction failed', err);
        }

        return null;
    }

    /**
     * 파일에서 직접 ya29 토큰 추출 (호환성용 - deprecated)
     */
    async extractTokenFromDb(): Promise<string | null> {
        const result = await this.extractTokensFromDb();
        return result?.accessToken || null;
    }

    /**
     * 현재 Antigravity에 로그인된 이메일 추출
     * tfa.lastUserInfo 키에서 직접 추출 (가장 정확함)
     */
    async getCurrentLoggedInEmail(): Promise<string | null> {
        const dbPath = this.getStateDbPath();
        
        if (!fs.existsSync(dbPath)) {
            return null;
        }

        try {
            const fileBuffer = fs.readFileSync(dbPath);
            const content = fileBuffer.toString('utf8');

            // 1. tfa.lastUserInfo에서 email 찾기 (가장 정확 - 현재 활성 사용자)
            const lastUserInfoIndex = content.indexOf('tfa.lastUserInfo');
            if (lastUserInfoIndex !== -1) {
                const searchRange = content.substring(lastUserInfoIndex, lastUserInfoIndex + 500);
                const emailMatch = searchRange.match(/"email"\s*:\s*"([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})"/);
                if (emailMatch && emailMatch[1]) {
                    const email = emailMatch[1].toLowerCase();
                    console.log(`ReRevolve: Current logged in email (from tfa.lastUserInfo): ${email}`);
                    return email;
                }
            }

            // 2. antigravityAuthStatus 키 값에서 email 찾기 (대안)
            const authStatusIndex = content.indexOf('antigravityAuthStatus');
            if (authStatusIndex !== -1) {
                const searchRange = content.substring(authStatusIndex, authStatusIndex + 2000);
                const emailMatch = searchRange.match(/"email"\s*:\s*"([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})"/);
                if (emailMatch && emailMatch[1]) {
                    const email = emailMatch[1].toLowerCase();
                    console.log(`ReRevolve: Current logged in email (from antigravityAuthStatus): ${email}`);
                    return email;
                }
            }

            // 3. tierDescription:"Google AI Pro" 근처에서 email 찾기
            const tierProIndex = content.indexOf('"tierDescription":"Google AI Pro"');
            if (tierProIndex !== -1) {
                // 앞쪽 200바이트에서 email 찾기
                const searchStart = Math.max(0, tierProIndex - 200);
                const searchRange = content.substring(searchStart, tierProIndex + 100);
                const emailMatch = searchRange.match(/"email"\s*:\s*"([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})"/);
                if (emailMatch && emailMatch[1]) {
                    const email = emailMatch[1].toLowerCase();
                    console.log(`ReRevolve: Current logged in email (from tierDescription): ${email}`);
                    return email;
                }
            }

            // 4. 최후의 대안: 일반 email 패턴 (파일 끝 쪽 우선)
            const emailRegex = /"email"\s*:\s*"([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})"/g;
            const foundEmails: { index: number; email: string }[] = [];
            let match;

            while ((match = emailRegex.exec(content)) !== null) {
                const email = match[1].toLowerCase();
                // rerevolve 관련 키는 제외
                if (!email.includes('rerevolve') && !email.includes('token.')) {
                    foundEmails.push({ index: match.index, email });
                }
            }

            if (foundEmails.length > 0) {
                // 가장 마지막(최신) 이메일 사용
                foundEmails.sort((a, b) => a.index - b.index);
                const lastEmail = foundEmails[foundEmails.length - 1];
                console.log(`ReRevolve: Current logged in email (fallback): ${lastEmail.email}`);
                return lastEmail.email;
            }

        } catch (err) {
            console.error('ReRevolve: Email extraction failed', err);
        }

        return null;
    }

    /**
     * 현재 Antigravity 로그인 계정의 토큰 캡처 및 저장
     * ⚠️ 중요: 파라미터 email이 아닌 현재 로그인된 계정의 email로 저장됨
     */
    async captureCurrentToken(email: string): Promise<boolean> {
        try {
            // 1. antigravityAuthStatus에서 현재 계정 정보 직접 추출 (가장 신뢰할 수 있음)
            const authStatus = await this.getAuthStatus();
            
            if (!authStatus) {
                vscode.window.showErrorMessage('ReRevolve: 현재 로그인된 계정을 감지할 수 없습니다. Antigravity에 로그인되어 있는지 확인하세요.');
                return false;
            }

            const currentEmail = authStatus.email?.toLowerCase();
            const accessToken = authStatus.apiKey;

            if (!currentEmail || !accessToken) {
                vscode.window.showErrorMessage('ReRevolve: 현재 로그인 정보를 읽을 수 없습니다.');
                return false;
            }

            // 2. Refresh token은 oauthToken에서 추출 (현재 계정의 토큰)
            let refreshToken: string | undefined;
            try {
                refreshToken = await this.getRefreshToken() || undefined;
            } catch {
                console.log('ReRevolve: Refresh token extraction failed, continuing without it');
            }

            // 3. 현재 로그인 계정으로 저장
            if (email.toLowerCase() !== currentEmail) {
                vscode.window.showWarningMessage(
                    `⚠️ 현재 로그인된 계정은 ${currentEmail}입니다. ` +
                    `${email} 대신 ${currentEmail}로 토큰이 저장됩니다.`
                );
            }

            const credential: StoredCredential = {
                accessToken,
                refreshToken,
                expiresAt: Date.now() + 55 * 60 * 1000, // 55분 후 만료
                email: currentEmail,
                createdAt: Date.now()
            };

            await this.secrets.store(TOKEN_PREFIX + currentEmail, JSON.stringify(credential));
            
            const hasRefresh = refreshToken ? ' (리프레시 토큰 포함 🔄)' : ' (액세스 토큰만)';
            console.log(`ReRevolve: Token captured for ${currentEmail}${hasRefresh}`);
            
            vscode.window.showInformationMessage(`ReRevolve: ${currentEmail} 토큰 캡처 완료!${hasRefresh}`);
            return true;
        } catch (err) {
            console.error('ReRevolve: Token capture failed', err);
            vscode.window.showErrorMessage(`ReRevolve: 토큰 캡처 실패: ${err}`);
            return false;
        }
    }

    /**
     * 저장된 토큰 조회 (만료 시 갱신 시도, 없으면 자동 복구)
     */
    async getToken(email: string): Promise<string | null> {
        let stored = await this.secrets.get(TOKEN_PREFIX + email);
        
        // SecretStorage에 없으면 state.vscdb에서 자동 복구 시도
        if (!stored) {
            console.log(`ReRevolve: Token not in SecretStorage for ${email}, attempting auto-recovery...`);
            const recovered = await this.tryAutoRecovery(email);
            if (recovered) {
                stored = await this.secrets.get(TOKEN_PREFIX + email);
            }
        }
        
        if (!stored) {
            return null;
        }

        try {
            const credential: StoredCredential = JSON.parse(stored);
            
            // 토큰이 만료되었으면 갱신 시도
            if (Date.now() > credential.expiresAt - 5 * 60 * 1000) {
                console.log(`ReRevolve: Token expired for ${email}, attempting refresh...`);
                const refreshed = await this.refreshAccessToken(credential);
                if (refreshed) {
                    credential.accessToken = refreshed.accessToken;
                    credential.expiresAt = refreshed.expiresAt;
                    await this.secrets.store(TOKEN_PREFIX + email, JSON.stringify(credential));
                    console.log(`ReRevolve: Token refreshed successfully for ${email}`);
                    return refreshed.accessToken;
                }
                
                // 갱신 실패 시 자동 복구 시도 (state.vscdb에서 새 토큰 추출)
                console.log(`ReRevolve: Token refresh failed for ${email}, attempting auto-recovery...`);
                const recovered = await this.tryAutoRecovery(email);
                if (recovered) {
                    const newStored = await this.secrets.get(TOKEN_PREFIX + email);
                    if (newStored) {
                        const newCredential: StoredCredential = JSON.parse(newStored);
                        console.log(`ReRevolve: Auto-recovery successful for ${email}`);
                        return newCredential.accessToken;
                    }
                }
                
                // 자동 복구도 실패하면 기존 만료된 토큰 반환 (API가 401 처리)
                console.log(`ReRevolve: All recovery attempts failed for ${email}, returning expired token`);
            }
            
            return credential.accessToken;
        } catch {
            // JSON 파싱 실패 -> 구버전 raw 토큰
            if (typeof stored === 'string' && stored.length > 10) {
                return stored;
            }
            return null;
        }
    }

    /**
     * Refresh Token으로 새 Access Token 획득
     */
    private async refreshAccessToken(credential: StoredCredential): Promise<{ accessToken: string; expiresAt: number } | null> {
        if (!credential.refreshToken) {
            return null;
        }

        try {
            const response = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: credential.refreshToken,
                    client_id: ANTIGRAVITY_CLIENT_ID,
                    client_secret: ANTIGRAVITY_CLIENT_SECRET,
                }),
            });

            if (!response.ok) {
                console.log(`ReRevolve: Token refresh failed: ${response.status}`);
                return null;
            }

            const data = await response.json() as { access_token: string; expires_in: number };
            return {
                accessToken: data.access_token,
                expiresAt: Date.now() + data.expires_in * 1000,
            };
        } catch (err) {
            console.error('ReRevolve: Token refresh error', err);
            return null;
        }
    }

    /**
     * 토큰 존재 및 유효성 확인
     * 토큰이 만료되었지만 refreshToken이 있으면 true 반환 (갱신 가능)
     */
    async hasToken(email: string): Promise<boolean> {
        const stored = await this.secrets.get(TOKEN_PREFIX + email);
        if (!stored || stored.length <= 10) {
            return false;
        }
        
        try {
            const credential: StoredCredential = JSON.parse(stored);
            
            // 만료되지 않았으면 유효
            if (Date.now() <= credential.expiresAt - 5 * 60 * 1000) {
                return true;
            }
            
            // 만료되었지만 refreshToken이 있으면 유효 (갱신 가능)
            if (credential.refreshToken) {
                return true;
            }
            
            // 만료되었고 refreshToken도 없으면 무효
            return false;
        } catch {
            // JSON 파싱 실패 → 구버전 raw 토큰 (유효하지 않음으로 간주)
            return false;
        }
    }

    /**
     * 토큰 삭제
     */
    async deleteToken(email: string): Promise<void> {
        await this.secrets.delete(TOKEN_PREFIX + email);
    }

    /**
     * 토큰 저장 (가져오기용)
     */
    async saveToken(email: string, tokenData: string): Promise<void> {
        await this.secrets.store(TOKEN_PREFIX + email, tokenData);
    }

    /**
     * 자동 복구 시도 - state.vscdb에서 토큰 추출하여 저장
     */
    private async tryAutoRecovery(email: string): Promise<boolean> {
        try {
            const tokens = await this.extractTokensFromDb();
            if (!tokens) {
                console.log('ReRevolve: Auto-recovery failed - no tokens in state.vscdb');
                return false;
            }

            const credential: StoredCredential = {
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt: Date.now() + 55 * 60 * 1000,
                email,
                createdAt: Date.now()
            };

            await this.secrets.store(TOKEN_PREFIX + email, JSON.stringify(credential));
            console.log(`ReRevolve: Auto-recovery successful for ${email}`);
            vscode.window.showInformationMessage(`ReRevolve: ${email} 토큰 자동 복구 완료! 🔄`);
            return true;
        } catch (err) {
            console.error('ReRevolve: Auto-recovery error', err);
            return false;
        }
    }

    // ========== OAuth 인증 플로우 ==========

    /**
     * OAuth 인증 URL 생성 및 브라우저 열기
     */
    async startOAuthFlow(email: string): Promise<void> {
        // Google OAuth 2.0 인증 URL 생성
        const redirectUri = 'urn:ietf:wg:oauth:2.0:oob';
        const scope = encodeURIComponent('openid email profile https://www.googleapis.com/auth/cloud-platform');
        
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
            `client_id=${ANTIGRAVITY_CLIENT_ID}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&response_type=code` +
            `&scope=${scope}` +
            `&access_type=offline` +
            `&prompt=consent` +
            `&login_hint=${encodeURIComponent(email)}`;
        
        console.log(`ReRevolve: Starting OAuth flow for ${email}`);
        
        // 브라우저에서 인증 페이지 열기
        await vscode.env.openExternal(vscode.Uri.parse(authUrl));
        
        vscode.window.showInformationMessage(
            `🔐 브라우저에서 ${email}로 로그인하세요. 인증 코드가 표시되면 복사하세요.`,
            '인증 코드 입력'
        ).then(async (selection) => {
            if (selection === '인증 코드 입력') {
                await this.promptForAuthCode(email);
            }
        });
    }

    /**
     * 인증 코드 입력 프롬프트
     */
    async promptForAuthCode(email: string): Promise<boolean> {
        const code = await vscode.window.showInputBox({
            prompt: `${email}의 인증 코드를 입력하세요`,
            placeHolder: '4/0XXXXXX...',
            ignoreFocusOut: true,
            password: false
        });

        if (!code) {
            vscode.window.showWarningMessage('인증이 취소되었습니다.');
            return false;
        }

        return await this.exchangeCodeForToken(code.trim(), email);
    }

    /**
     * 인증 코드를 토큰으로 교환
     */
    async exchangeCodeForToken(code: string, email: string): Promise<boolean> {
        try {
            console.log(`ReRevolve: Exchanging auth code for ${email}`);
            
            const response = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    code: code,
                    client_id: ANTIGRAVITY_CLIENT_ID,
                    client_secret: ANTIGRAVITY_CLIENT_SECRET,
                    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
                    grant_type: 'authorization_code',
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('ReRevolve: Token exchange failed:', errorText);
                vscode.window.showErrorMessage(`인증 실패: ${response.status} - ${errorText}`);
                return false;
            }

            const data = await response.json() as {
                access_token: string;
                refresh_token?: string;
                expires_in: number;
                id_token?: string;
            };

            if (!data.access_token) {
                vscode.window.showErrorMessage('인증 실패: 액세스 토큰을 받지 못했습니다.');
                return false;
            }

            // 토큰 저장
            const credential: StoredCredential = {
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
                expiresAt: Date.now() + (data.expires_in * 1000),
                email,
                createdAt: Date.now()
            };

            await this.secrets.store(TOKEN_PREFIX + email, JSON.stringify(credential));

            const hasRefresh = data.refresh_token ? ' (리프레시 토큰 포함 🔄)' : ' (액세스 토큰만)';
            console.log(`ReRevolve: OAuth successful for ${email}${hasRefresh}`);
            vscode.window.showInformationMessage(`✅ ${email} 인증 완료!${hasRefresh}`);
            
            return true;
        } catch (err) {
            console.error('ReRevolve: OAuth token exchange error', err);
            vscode.window.showErrorMessage(`인증 오류: ${err}`);
            return false;
        }
    }

    /**
     * OAuth 인증 여부 확인 (리프레시 토큰 존재 여부)
     */
    async hasValidOAuth(email: string): Promise<boolean> {
        const stored = await this.secrets.get(TOKEN_PREFIX + email);
        if (!stored) return false;

        try {
            const credential: StoredCredential = JSON.parse(stored);
            return !!credential.refreshToken;
        } catch {
            return false;
        }
    }
}

