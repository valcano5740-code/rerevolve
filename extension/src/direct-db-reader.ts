/**
 * Direct Buffer Reader - state.vscdb 직접 버퍼 스캔 모듈
 * 
 * sql.js (WASM) 없이 SQLite 파일에서 key-value 쌍을 추출합니다.
 * 기동 시 WASM 블로킹으로 인한 흰 화면(White Screen) 프리징을 완전히 제거합니다.
 * 
 * 원리:
 * - SQLite 파일의 바이너리를 latin1 문자열로 변환하여 키 문자열을 검색
 * - 키 직후 영역에서 정규식으로 필요한 필드만 추출 (전체 JSON 파싱 불필요)
 * - Overflow Page로 인해 JSON이 잘려도 앞부분 필드는 안전하게 추출 가능
 * 
 * 성능: 0.1ms 미만 (fs.readFileSync + indexOf 스캔)
 * 의존성: 0개 (Node.js 내장 fs, Buffer만 사용)
 */
import * as fs from 'fs';

/** 버퍼 캐시 - 같은 파일을 반복 읽기 방지 (mtime 기반 무효화) */
let cachedBuffer: { path: string; mtime: number; buffer: Buffer } | null = null;

function getFileBuffer(dbPath: string): Buffer {
    const stat = fs.statSync(dbPath);
    const mtime = stat.mtimeMs;

    if (cachedBuffer && cachedBuffer.path === dbPath && cachedBuffer.mtime === mtime) {
        return cachedBuffer.buffer;
    }

    const buffer = fs.readFileSync(dbPath);
    cachedBuffer = { path: dbPath, mtime, buffer };
    return buffer;
}

/** 캐시 무효화 (state.vscdb 변경 감지 시 호출) */
export function invalidateBufferCache(): void {
    cachedBuffer = null;
}

/**
 * SQLite 파일에서 특정 키의 값을 직접 버퍼 스캔으로 추출합니다.
 * JSON 또는 base64 형태의 값을 자동 감지합니다.
 * 
 * @param dbPath - state.vscdb 파일 경로
 * @param key - 검색할 키 (예: 'antigravityAuthStatus')
 * @returns 키에 해당하는 값 문자열 또는 null
 */
export function readValueDirect(dbPath: string, key: string): string | null {
    if (!fs.existsSync(dbPath)) return null;

    try {
        const buffer = getFileBuffer(dbPath);
        const str = buffer.toString('latin1');
        const candidates: { index: number; value: string; type: string }[] = [];
        let searchFrom = -1;

        while ((searchFrom = str.indexOf(key, searchFrom + 1)) !== -1) {
            const startOffset = searchFrom + key.length;
            const searchArea = str.substring(startOffset, startOffset + 4000);

            // JSON 값 감지 ({로 시작하는 값이 키 직후 50바이트 이내에 있는 경우)
            const jsonStart = searchArea.indexOf('{');
            if (jsonStart !== -1 && jsonStart < 50) {
                const jsonPart = searchArea.substring(jsonStart);
                // 중괄호 깊이 추적으로 JSON 끝 찾기
                let depth = 0;
                let jsonEnd = -1;
                for (let i = 0; i < jsonPart.length; i++) {
                    if (jsonPart[i] === '{') depth++;
                    else if (jsonPart[i] === '}') {
                        depth--;
                        if (depth === 0) {
                            jsonEnd = i + 1;
                            break;
                        }
                    }
                }

                if (jsonEnd > 0) {
                    candidates.push({ index: searchFrom, value: jsonPart.substring(0, jsonEnd), type: 'json_complete' });
                } else {
                    // JSON이 잘림 (overflow page) - 부분 데이터라도 반환
                    candidates.push({ index: searchFrom, value: jsonPart, type: 'json_partial' });
                }
                continue;
            }

            // Base64 값 감지 (키 직후 15바이트 이내에 연속 base64 문자가 50자 이상)
            for (let i = 0; i < 15 && i < searchArea.length; i++) {
                const char = searchArea[i];
                if (/[a-zA-Z0-9+/=]/.test(char)) {
                    let len = 0;
                    while (i + len < searchArea.length && /[a-zA-Z0-9+/=]/.test(searchArea[i + len])) {
                        len++;
                    }
                    if (len > 50) {
                        candidates.push({ index: searchFrom, value: searchArea.substring(i, i + len), type: 'base64' });
                        break;
                    }
                }
            }
        }

        if (candidates.length > 0) {
            // 완전한 JSON 값 우선
            const complete = candidates.filter(c => c.type === 'json_complete');
            if (complete.length > 0) {
                return complete[complete.length - 1].value;
            }
            // 없으면 가장 마지막(최신) 후보
            return candidates[candidates.length - 1].value;
        }
    } catch (err) {
        console.error(`DirectReader: Failed to read key '${key}'`, err);
    }

    return null;
}

/**
 * 특정 키의 JSON 값에서 지정된 필드들만 정규식으로 추출합니다.
 * Overflow Page로 JSON이 잘려도 앞부분의 필드는 안전하게 추출됩니다.
 * 
 * @param dbPath - state.vscdb 파일 경로
 * @param key - 검색할 키
 * @param fields - 추출할 JSON 필드명 배열 (예: ['email', 'apiKey'])
 * @returns 필드명-값 맵 또는 null
 */
export function readJsonFieldsDirect(
    dbPath: string,
    key: string,
    fields: string[]
): Record<string, string> | null {
    if (!fs.existsSync(dbPath)) return null;

    try {
        const buffer = getFileBuffer(dbPath);
        const str = buffer.toString('latin1');
        const results: { index: number; parsed: Record<string, string> }[] = [];
        let searchFrom = -1;

        while ((searchFrom = str.indexOf(key, searchFrom + 1)) !== -1) {
            const startOffset = searchFrom + key.length;
            const searchArea = str.substring(startOffset, startOffset + 4000);

            const jsonStart = searchArea.indexOf('{');
            if (jsonStart === -1 || jsonStart >= 50) continue;

            const jsonPart = searchArea.substring(jsonStart);
            const parsed: Record<string, string> = {};
            let foundAny = false;

            for (const field of fields) {
                const regex = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`, '');
                const match = jsonPart.match(regex);
                if (match && match[1]) {
                    // latin1 → utf8 변환 (한글 등 멀티바이트 문자 복원)
                    parsed[field] = Buffer.from(match[1], 'latin1').toString('utf8');
                    foundAny = true;
                }
            }

            if (foundAny) {
                results.push({ index: searchFrom, parsed });
            }
        }

        if (results.length > 0) {
            // 가장 뒤(최신) 결과 반환
            return results[results.length - 1].parsed;
        }
    } catch (err) {
        console.error(`DirectReader: Failed to read JSON fields for '${key}'`, err);
    }

    return null;
}

/**
 * 특정 키의 base64 인코딩된 값을 추출합니다.
 * oauthToken, agentManagerInitState 등 protobuf 직렬화 값에 사용.
 * 
 * @param dbPath - state.vscdb 파일 경로
 * @param key - 검색할 키
 * @returns base64 문자열 또는 null
 */
export function readBase64ValueDirect(dbPath: string, key: string): string | null {
    if (!fs.existsSync(dbPath)) return null;

    try {
        const buffer = getFileBuffer(dbPath);
        const str = buffer.toString('latin1');
        const candidates: { index: number; value: string }[] = [];
        let searchFrom = -1;

        while ((searchFrom = str.indexOf(key, searchFrom + 1)) !== -1) {
            const startOffset = searchFrom + key.length;
            // base64 값은 매우 길 수 있으므로 넓은 영역 검색
            const searchArea = str.substring(startOffset, startOffset + 8000);

            for (let i = 0; i < 15 && i < searchArea.length; i++) {
                const char = searchArea[i];
                if (/[a-zA-Z0-9+/=]/.test(char)) {
                    let len = 0;
                    while (i + len < searchArea.length && /[a-zA-Z0-9+/=]/.test(searchArea[i + len])) {
                        len++;
                    }
                    if (len > 50) {
                        candidates.push({ index: searchFrom, value: searchArea.substring(i, i + len) });
                        break;
                    }
                }
            }
        }

        if (candidates.length > 0) {
            return candidates[candidates.length - 1].value;
        }
    } catch (err) {
        console.error(`DirectReader: Failed to read base64 for '${key}'`, err);
    }

    return null;
}
