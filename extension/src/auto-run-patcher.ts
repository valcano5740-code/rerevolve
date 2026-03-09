/**
 * Auto-Run Patcher — "Always Proceed" 터미널 정책 버그 수정
 * 
 * Antigravity IDE의 run_command 컴포넌트에 누락된 useEffect를 주입하여
 * "Always Proceed" 설정이 새 명령에도 자동 적용되도록 합니다.
 * 
 * Better Antigravity (by Kanezal)의 패치 방식을 참고하여 구현.
 * 구조적 정규식 매칭으로 minified 변수 이름 변경에도 대응합니다.
 * 
 * @module auto-run-patcher
 */

import * as path from 'path';
import * as fs from 'fs';

// 패치 마커 (Better Antigravity의 BA:autorun과 구분)
const PATCH_MARKER = '/*RR:autorun*/';

/** Better Antigravity 패치 마커 (중복 패치 방지) */
const BA_PATCH_MARKER = '/*BA:autorun*/';

// ===== 경로 탐색 =====

/**
 * Antigravity workbench 디렉토리 탐색
 * Windows/Mac/Linux 지원
 */
export function getWorkbenchDir(): string | null {
    const candidates: string[] = [];

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || '';
        candidates.push(
            path.join(localAppData, 'Programs', 'Antigravity', 'resources', 'app', 'out', 'vs', 'code', 'electron-browser', 'workbench'),
            path.join(localAppData, 'Programs', 'Antigravity', 'resources', 'app', 'out', 'vs', 'workbench')
        );
    } else if (process.platform === 'darwin') {
        candidates.push(
            '/Applications/Antigravity.app/Contents/Resources/app/out/vs/code/electron-browser/workbench',
            '/Applications/Antigravity.app/Contents/Resources/app/out/vs/workbench'
        );
    } else {
        const home = process.env.HOME || '';
        candidates.push(
            path.join(home, '.local', 'share', 'Antigravity', 'resources', 'app', 'out', 'vs', 'code', 'electron-browser', 'workbench'),
            path.join(home, '.local', 'share', 'Antigravity', 'resources', 'app', 'out', 'vs', 'workbench')
        );
    }

    for (const dir of candidates) {
        if (fs.existsSync(dir)) return dir;
    }
    return null;
}

/**
 * 패치 대상 파일 목록
 */
export function getTargetFiles(workbenchDir: string): Array<{ path: string; label: string }> {
    // workbench 하위 파일
    const targets: Array<{ path: string; label: string }> = [
        { path: path.join(workbenchDir, 'workbench.desktop.main.js'), label: 'workbench' },
    ];

    // jetskiAgent.js는 상위 디렉토리에서 탐색
    const appOutDir = path.resolve(workbenchDir, '..', '..');
    const jetskiCandidates = [
        path.join(appOutDir, 'jetskiAgent.js'),
        path.join(workbenchDir, 'jetskiAgent.js'),
    ];
    for (const jp of jetskiCandidates) {
        if (fs.existsSync(jp)) {
            targets.push({ path: jp, label: 'jetskiAgent' });
            break;
        }
    }

    return targets.filter(f => fs.existsSync(f.path));
}

// ===== 분석 =====

interface AnalysisResult {
    enumName: string;
    confirmFn: string;
    policyVar: string;
    secureVar: string;
    useEffectFn: string;
    insertAt: number;
}

/**
 * 파일 내에서 onChange 핸들러를 구조적 정규식으로 탐색하고
 * 주변 컨텍스트에서 변수 이름을 추출합니다.
 */
function analyzeFile(content: string): AnalysisResult | null {
    // onChange 핸들러 패턴: callback=useCallback((arg)=>{setFn(arg),arg===ENUM.EAGER&&confirm(!0)},[...])
    const onChangeRegex = /(\w+)=(\w+)\((\(\w+\))=>\{(\w+)\(\w+\),\w+===(\w+)\.EAGER&&(\w+)\(!0\)\},\[/g;
    const match = onChangeRegex.exec(content);

    if (!match) return null;

    const [fullMatch, , , , , enumName, confirmFn] = match;
    const insertPos = match.index + fullMatch.length;

    // 주변 3000자 컨텍스트에서 변수 추출
    const contextStart = Math.max(0, match.index - 3000);
    const contextEnd = Math.min(content.length, match.index + 3000);
    const context = content.substring(contextStart, contextEnd);

    // policyVar: <var>=<something>?.terminalAutoExecutionPolicy??<ENUM>.OFF
    const policyMatch = /(\w+)=\w+\?\.terminalAutoExecutionPolicy\?\?(\w+)\.OFF/.exec(context);
    // secureVar: <var>=<something>?.secureModeEnabled??!1
    const secureMatch = /(\w+)=\w+\?\.secureModeEnabled\?\?!1/.exec(context);

    if (!policyMatch || !secureMatch) return null;

    const policyVar = policyMatch[1];
    const secureVar = secureMatch[1];

    // useEffect 함수 이름 추출 (빈도 분석)
    const useEffectFn = findUseEffect(context, [confirmFn]);
    if (!useEffectFn) return null;

    // 삽입 위치: useCallback 닫는 부분 이후
    const afterOnChange = content.indexOf('])', insertPos);
    if (afterOnChange === -1) return null;

    const insertAt = content.indexOf(';', afterOnChange);
    if (insertAt === -1) return null;

    return {
        enumName,
        confirmFn,
        policyVar,
        secureVar,
        useEffectFn,
        insertAt: insertAt + 1,
    };
}

/**
 * useEffect 함수 이름을 빈도 분석으로 추출
 * React 훅은 minified 코드에서 짧은 이름(1-3글자)의 함수로 나타나며
 * `fn(()=>{...})` 패턴으로 가장 빈번하게 사용되는 것이 useEffect
 */
function findUseEffect(context: string, exclude: string[]): string | null {
    const candidates: Record<string, number> = {};
    const regex = /(\w{1,3})\(\(\)=>\{/g;
    let m;

    while ((m = regex.exec(context)) !== null) {
        const fn = m[1];
        if (fn.length <= 3 && !exclude.includes(fn)) {
            candidates[fn] = (candidates[fn] || 0) + 1;
        }
    }

    let best = '';
    let maxCount = 0;
    for (const [fn, count] of Object.entries(candidates)) {
        if (count > maxCount) {
            best = fn;
            maxCount = count;
        }
    }

    return best || null;
}

// ===== 패치/복원 =====

export interface PatchResult {
    success: boolean;
    label: string;
    status: 'patched' | 'already-patched' | 'ba-patched' | 'pattern-not-found' | 'reverted' | 'no-backup' | 'error';
    bytesAdded?: number;
    error?: string;
    details?: string;
}

/**
 * 단일 파일 패치 적용
 */
export async function patchFile(filePath: string, label: string): Promise<PatchResult> {
    try {
        let content = fs.readFileSync(filePath, 'utf8');

        // 이미 패치됨 체크
        if (content.includes(PATCH_MARKER)) {
            return { success: true, label, status: 'already-patched' };
        }

        // Better Antigravity 패치가 이미 적용된 경우
        if (content.includes(BA_PATCH_MARKER)) {
            return { success: true, label, status: 'ba-patched', details: 'Better Antigravity 패치 감지 → 중복 적용 건너뜀' };
        }

        const analysis = analyzeFile(content);
        if (!analysis) {
            return { success: false, label, status: 'pattern-not-found', details: 'onChange 핸들러 패턴을 찾지 못함 (Antigravity가 이미 수정했을 수 있음)' };
        }

        const { enumName, confirmFn, policyVar, secureVar, useEffectFn, insertAt } = analysis;

        // 패치 코드 생성
        const patch = `${PATCH_MARKER}${useEffectFn}(()=>{${policyVar}===${enumName}.EAGER&&!${secureVar}&&${confirmFn}(!0)},[])`;

        // 백업 생성 (최초 1회)
        const backup = filePath + '.rr-backup';
        if (!fs.existsSync(backup)) {
            fs.copyFileSync(filePath, backup);
        }

        // 패치 삽입
        content = content.substring(0, insertAt) + patch + content.substring(insertAt);
        fs.writeFileSync(filePath, content, 'utf8');

        const details = `callback=${analysis.useEffectFn}, enum=${enumName}, confirm=${confirmFn}, policy=${policyVar}, secure=${secureVar}`;
        return { success: true, label, status: 'patched', bytesAdded: patch.length, details };
    } catch (err: any) {
        return { success: false, label, status: 'error', error: err.message };
    }
}

/**
 * 단일 파일 패치 복원
 */
export function revertFile(filePath: string, label: string): PatchResult {
    const backup = filePath + '.rr-backup';
    if (!fs.existsSync(backup)) {
        return { success: false, label, status: 'no-backup' };
    }

    try {
        fs.copyFileSync(backup, filePath);
        fs.unlinkSync(backup);
        return { success: true, label, status: 'reverted' };
    } catch (err: any) {
        return { success: false, label, status: 'error', error: err.message };
    }
}

/**
 * 파일의 패치 상태 확인
 */
export function checkPatchStatus(filePath: string): 'patched' | 'ba-patched' | 'unpatched' | 'not-found' {
    if (!fs.existsSync(filePath)) return 'not-found';
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes(PATCH_MARKER)) return 'patched';
        if (content.includes(BA_PATCH_MARKER)) return 'ba-patched';
        return 'unpatched';
    } catch {
        return 'not-found';
    }
}

// ===== 일괄 작업 =====

/**
 * 모든 대상 파일에 자동 패치 적용
 */
export async function autoApply(): Promise<PatchResult[]> {
    const dir = getWorkbenchDir();
    if (!dir) {
        return [{ success: false, label: 'system', status: 'error', error: 'Antigravity workbench 디렉토리를 찾을 수 없음' }];
    }

    const files = getTargetFiles(dir);
    if (files.length === 0) {
        return [{ success: false, label: 'system', status: 'error', error: '패치 대상 파일을 찾을 수 없음' }];
    }

    const results: PatchResult[] = [];
    for (const f of files) {
        results.push(await patchFile(f.path, f.label));
    }
    return results;
}

/**
 * 모든 패치 복원
 */
export function revertAll(): PatchResult[] {
    const dir = getWorkbenchDir();
    if (!dir) return [];

    const files = getTargetFiles(dir);
    return files.map(f => revertFile(f.path, f.label));
}

/**
 * 전체 패치 상태 조회
 */
export function getStatus(): Array<{ label: string; status: string; path: string }> {
    const dir = getWorkbenchDir();
    if (!dir) return [{ label: 'system', status: 'Antigravity 미설치', path: '' }];

    const files = getTargetFiles(dir);
    return files.map(f => ({
        label: f.label,
        status: checkPatchStatus(f.path),
        path: f.path
    }));
}
