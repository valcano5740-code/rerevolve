/**
 * CDP Setup Service - Antigravity CDP 환경 자동 설정
 * 
 * Auto-Accept 첫 실행 시:
 * 1. boost_silent.vbs 생성 (GPU 플래그 + RunAsInvoker + CDP 9000)
 * 2. HKCU 우클릭 "Antigravity Boost" 등록
 * 3. HKCU 우클릭 "Antigravity (Original)" CDP 오버라이드
 * 4. .lnk 바로가기에 CDP 인자 추가
 * 
 * 모든 작업은 HKCU + 사용자 폴더 → 관리자 권한 불필요
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

const CDP_PORT = 9000;
const CDP_SETUP_KEY = 'cdpSetupDone';
const CDP_ARG = `--remote-debugging-port=${CDP_PORT}`;

// boost_silent.vbs template (ASCII-safe, no multi-byte chars)
const BOOST_VBS_TEMPLATE = `' Antigravity Boost Launcher (ReRevolve CDP Setup)
' Usage: wscript boost_silent.vbs "folderPath"
' Features: zombie cleanup + RunAsInvoker + GPU boost + CDP

Set objShell = CreateObject("WScript.Shell")

' Get folder path
If WScript.Arguments.Count > 0 Then
    folderPath = WScript.Arguments(0)
Else
    folderPath = objShell.CurrentDirectory
End If

' [1] Clean orphan processes on port 26646
objShell.Run "powershell -WindowStyle Hidden -Command ""Get-NetTCPConnection -LocalPort 26646 -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.Name -ne 'Antigravity') { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }""", 0, True

' [2] Launch Antigravity (Boost flags + CDP)
antigravityExe = "<ANTIGRAVITY_EXE>"
boostFlags = "--remote-debugging-port=${CDP_PORT} --enable-gpu-rasterization --enable-zero-copy --disable-gpu-driver-bug-workarounds"

' Drop admin privileges via env var
objShell.Environment("Process")("__COMPAT_LAYER") = "RunAsInvoker"

objShell.Run """" & antigravityExe & """ """ & folderPath & """ " & boostFlags, 1, False
`;

export class CdpSetupService {
    /**
     * CDP 환경 설정 확인 및 실행 (1회만)
     */
    static async ensureSetup(globalState: vscode.Memento): Promise<boolean> {
        // CDP 포트가 이미 열려있으면 설정 불필요 (Boost로 실행된 경우)
        try {
            const net = await import('net');
            const portOpen = await new Promise<boolean>((resolve) => {
                const sock = new net.Socket();
                sock.setTimeout(500);
                sock.on('connect', () => { sock.destroy(); resolve(true); });
                sock.on('error', () => resolve(false));
                sock.on('timeout', () => { sock.destroy(); resolve(false); });
                sock.connect(9000, '127.0.0.1');
            });
            if (portOpen) {
                console.log('ReRevolve CDP: 포트 9000 이미 열림 → 설정 건너뜀');
                await globalState.update(CDP_SETUP_KEY, true);
                return true;
            }
        } catch { /* net 모듈 실패 시 무시 */ }

        if (globalState.get<boolean>(CDP_SETUP_KEY, false)) {
            return true; // 이미 설정 완료 (재시작 후 적용 대기)
        }

        const answer = await vscode.window.showInformationMessage(
            '🔧 CDP 환경 설정이 필요합니다. 자동으로 설정할까요?\n(우클릭 메뉴 + 바로가기에 CDP 포트 추가)',
            '예, 설정합니다',
            '아니요, 건너뛰기'
        );

        if (answer !== '예, 설정합니다') {
            return false;
        }

        try {
            await CdpSetupService.setupAll();
            await globalState.update(CDP_SETUP_KEY, true);
            vscode.window.showInformationMessage(
                '✅ CDP 설정 완료! 다음 Antigravity 재시작부터 적용됩니다.'
            );
            return true;
        } catch (err: any) {
            vscode.window.showErrorMessage(`❌ CDP 설정 실패: ${err.message}`);
            return false;
        }
    }

    /**
     * CDP 설정 리셋 (재설정용)
     */
    static async resetSetup(globalState: vscode.Memento): Promise<void> {
        await globalState.update(CDP_SETUP_KEY, false);
        vscode.window.showInformationMessage('🔄 CDP 설정 플래그 초기화됨. 다음 Auto-Accept ON 시 재설정합니다.');
    }

    /**
     * 전체 설정 실행
     */
    static async setupAll(): Promise<void> {
        const antigravityExe = CdpSetupService.findAntigravityExe();
        if (!antigravityExe) {
            throw new Error('Antigravity.exe를 찾을 수 없습니다. 먼저 Antigravity를 설치해주세요.');
        }

        console.log('ReRevolve CDP: 설정 시작...');

        // 1. VBS 생성
        await CdpSetupService.createBoostVBS(antigravityExe);

        // 2. HKCU 우클릭 Boost 등록
        await CdpSetupService.registerBoostContextMenu();

        // 3. HKCU 우클릭 Original CDP 오버라이드
        await CdpSetupService.registerOriginalContextMenu(antigravityExe);

        // 4. .lnk 바로가기 수정
        await CdpSetupService.updateShortcuts();

        console.log('ReRevolve CDP: 설정 완료!');
    }

    /**
     * Antigravity.exe 경로 탐색
     */
    private static findAntigravityExe(): string | null {
        const candidates = [
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Antigravity', 'Antigravity.exe'),
            path.join(process.env.PROGRAMFILES || '', 'Antigravity', 'Antigravity.exe'),
        ];

        for (const p of candidates) {
            if (fs.existsSync(p)) {
                return p;
            }
        }
        return null;
    }

    /**
     * boost_silent.vbs 생성
     */
    private static async createBoostVBS(antigravityExe: string): Promise<void> {
        const userProfile = process.env.USERPROFILE || process.env.HOME || '';
        const vbsDir = path.join(userProfile, '.gemini', 'antigravity');
        const vbsPath = path.join(vbsDir, 'boost_silent.vbs');

        // 디렉토리 생성
        if (!fs.existsSync(vbsDir)) {
            fs.mkdirSync(vbsDir, { recursive: true });
        }

        // 기존 파일이 있으면 CDP 인자 포함 여부 확인
        if (fs.existsSync(vbsPath)) {
            const existing = fs.readFileSync(vbsPath, 'utf-8');
            if (existing.includes('remote-debugging-port')) {
                console.log('ReRevolve CDP: boost_silent.vbs에 이미 CDP 설정 있음');
                return;
            }
            // CDP 없으면 기존 파일에 CDP 추가
            const updated = existing.replace(
                /boostFlags\s*=\s*"([^"]*)"/,
                (_, flags) => `boostFlags = "${CDP_ARG} ${flags}"`
            );
            if (updated !== existing) {
                fs.writeFileSync(vbsPath, updated, 'utf-8');
                console.log('ReRevolve CDP: boost_silent.vbs에 CDP 인자 추가');
                return;
            }
        }

        // 신규 생성
        const vbsContent = BOOST_VBS_TEMPLATE.replace('<ANTIGRAVITY_EXE>', antigravityExe);
        fs.writeFileSync(vbsPath, vbsContent, 'utf-8');
        console.log(`ReRevolve CDP: boost_silent.vbs 생성 → ${vbsPath}`);
    }

    /**
     * HKCU 우클릭 "Antigravity Boost" 등록
     */
    private static async registerBoostContextMenu(): Promise<void> {
        const userProfile = process.env.USERPROFILE || process.env.HOME || '';
        const vbsPath = path.join(userProfile, '.gemini', 'antigravity', 'boost_silent.vbs');
        const iconExe = CdpSetupService.findAntigravityExe() || '';
        const basePath = 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\1_AntigravityBoost';

        const psLines = [
            `New-Item -Path '${basePath}\\command' -Force | Out-Null`,
            `Set-ItemProperty -Path '${basePath}' -Name '(Default)' -Value 'Antigravity Boost'`,
            `Set-ItemProperty -Path '${basePath}' -Name 'Icon' -Value '${iconExe}'`,
            `Set-ItemProperty -Path '${basePath}\\command' -Name '(Default)' -Value 'wscript.exe \"${vbsPath}\" \"%V\"'`,
        ];

        await CdpSetupService.runPs1(psLines);
        console.log('ReRevolve CDP: HKCU Antigravity Boost 등록 완료');
    }

    /**
     * HKCU 우클릭 "Antigravity (Original)" CDP 오버라이드
     */
    private static async registerOriginalContextMenu(antigravityExe: string): Promise<void> {
        const basePath = 'HKCU:\\Software\\Classes\\Directory\\Background\\shell\\2_AntigravityOriginal';

        const psLines = [
            `New-Item -Path '${basePath}\\command' -Force | Out-Null`,
            `Set-ItemProperty -Path '${basePath}' -Name '(Default)' -Value 'Antigravity (CDP)'`,
            `Set-ItemProperty -Path '${basePath}' -Name 'Icon' -Value '${antigravityExe}'`,
            `Set-ItemProperty -Path '${basePath}\\command' -Name '(Default)' -Value '\"${antigravityExe}\" ${CDP_ARG} \"%V\"'`,
        ];

        await CdpSetupService.runPs1(psLines);
        console.log('ReRevolve CDP: HKCU Antigravity Original (CDP) 등록 완료');
    }

    /**
     * 바로가기(.lnk) 파일에 CDP 인자 추가
     */
    private static async updateShortcuts(): Promise<void> {
        const searchPaths = [
            path.join(process.env.USERPROFILE || '', 'Desktop'),
            path.join(process.env.USERPROFILE || '', 'OneDrive', 'Desktop'),
            path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
            path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
        ];

        // 임시 .ps1 파일로 실행하여 이스케이프 문제 방지
        const tmpDir = process.env.TEMP || process.env.TMP || 'C:\\tmp';
        const ps1Path = path.join(tmpDir, 'rerevolve_cdp_shortcut.ps1');
        const cdpArg = CDP_ARG;

        const psScript = [
            '$WshShell = New-Object -ComObject WScript.Shell',
            `$searchPaths = @(${searchPaths.map(p => `"${p.replace(/\\/g, '\\')}"`).join(',')})`,
            '$modified = 0',
            'foreach ($searchPath in $searchPaths) {',
            '    if (!(Test-Path $searchPath)) { continue }',
            '    $shortcuts = Get-ChildItem -Path $searchPath -Recurse -Filter "*.lnk" -ErrorAction SilentlyContinue |',
            '        Where-Object { $_.Name -like "*Antigravity*" -and $_.Name -notlike "*Uninstall*" }',
            '    foreach ($shortcutFile in $shortcuts) {',
            '        try {',
            '            $shortcut = $WshShell.CreateShortcut($shortcutFile.FullName)',
            '            $args = $shortcut.Arguments',
            '            if ($args -match "remote-debugging-port") { continue }',
            `            $shortcut.Arguments = "${cdpArg} " + $args`,
            '            $shortcut.Save()',
            '            $modified++',
            '            Write-Host "Updated: $($shortcutFile.Name)"',
            '        } catch { }',
            '    }',
            '}',
            'Write-Host "Modified $modified shortcut(s)"',
        ].join('\n');

        fs.writeFileSync(ps1Path, psScript, 'utf-8');
        try {
            const result = await CdpSetupService.execPromise(
                `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}"`
            );
            console.log(`ReRevolve CDP: 바로가기 업데이트 완료 - ${result.trim()}`);
        } finally {
            try { fs.unlinkSync(ps1Path); } catch { }
        }
    }

    /**
     * 바로가기에 실제로 CDP 인자가 있는지 검증 (재설치 감지용)
     */
    private static async verifyShortcutHasCDP(): Promise<boolean> {
        const lnkPath = path.join(
            process.env.APPDATA || '',
            'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Antigravity', 'Antigravity.lnk'
        );
        if (!fs.existsSync(lnkPath)) return false;

        try {
            const result = await CdpSetupService.execPromise(
                `powershell -NoProfile -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}'); $s.Arguments"`
            );
            return result.includes('remote-debugging-port');
        } catch {
            return false;
        }
    }

    /**
     * CDP 설정 제거
     */
    static async removeSetup(globalState: vscode.Memento): Promise<void> {
        try {
            // HKCU 레지스트리 제거
            await CdpSetupService.execPromise(
                'reg delete "HKCU\\Software\\Classes\\Directory\\Background\\shell\\1_AntigravityBoost" /f 2>$null'
            ).catch(() => {});
            await CdpSetupService.execPromise(
                'reg delete "HKCU\\Software\\Classes\\Directory\\Background\\shell\\2_AntigravityOriginal" /f 2>$null'
            ).catch(() => {});

            await globalState.update(CDP_SETUP_KEY, false);
            vscode.window.showInformationMessage('🗑️ CDP 설정 제거 완료 (레지스트리 HKCU 항목 삭제됨)');
        } catch (err: any) {
            vscode.window.showErrorMessage(`CDP 설정 제거 실패: ${err.message}`);
        }
    }

    /**
     * PowerShell 스크립트 줄 배열을 임시 .ps1 파일로 실행 (이스케이프 문제 방지)
     */
    private static async runPs1(lines: string[]): Promise<string> {
        const tmpDir = process.env.TEMP || process.env.TMP || 'C:\\tmp';
        const ps1Path = path.join(tmpDir, `rerevolve_cdp_${Date.now()}.ps1`);
        fs.writeFileSync(ps1Path, lines.join('\n'), 'utf-8');
        try {
            return await CdpSetupService.execPromise(
                `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}"`
            );
        } finally {
            try { fs.unlinkSync(ps1Path); } catch { }
        }
    }

    private static execPromise(cmd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            exec(cmd, {
                shell: 'powershell.exe',
                encoding: 'utf8',
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
            }, (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(`${err.message}\n${stderr}`));
                } else {
                    resolve(stdout);
                }
            });
        });
    }
}
