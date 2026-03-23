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

// boost_silent.vbs 템플릿
const BOOST_VBS_TEMPLATE = `' Antigravity Boost Launcher (ReRevolve CDP Setup)
' 사용법: wscript boost_silent.vbs "폴더경로"
' 기능: 고아 좀비 프로세스 정리 + 관리자 권한 해제 + GPU 최적화 + CDP

Set objShell = CreateObject("WScript.Shell")

' 폴더 경로 받기
If WScript.Arguments.Count > 0 Then
    folderPath = WScript.Arguments(0)
Else
    folderPath = objShell.CurrentDirectory
End If

' [1] 포트 26646 고아 좀비 프로세스만 정리
objShell.Run "powershell -WindowStyle Hidden -Command ""Get-NetTCPConnection -LocalPort 26646 -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.Name -ne 'Antigravity') { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }""", 0, True

' [2] Antigravity 실행 (Boost 플래그 + CDP)
antigravityExe = "<ANTIGRAVITY_EXE>"
boostFlags = "--remote-debugging-port=${CDP_PORT} --enable-gpu-rasterization --enable-zero-copy --disable-gpu-driver-bug-workarounds"

' 환경변수로 관리자 권한 해제
objShell.Environment("Process")("__COMPAT_LAYER") = "RunAsInvoker"

objShell.Run """" & antigravityExe & """ """ & folderPath & """ " & boostFlags, 1, False
`;

export class CdpSetupService {
    /**
     * CDP 환경 설정 확인 및 실행 (1회만)
     */
    static async ensureSetup(globalState: vscode.Memento): Promise<boolean> {
        if (globalState.get<boolean>(CDP_SETUP_KEY, false)) {
            return true; // 이미 설정 완료
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

        const commands = [
            `reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\1_AntigravityBoost" /ve /d "Antigravity Boost" /f`,
            `reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\1_AntigravityBoost" /v "Icon" /d "${CdpSetupService.findAntigravityExe()}" /f`,
            `reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\1_AntigravityBoost\\command" /ve /d "wscript.exe \\"${vbsPath}\\" \\"%V\\"" /f`,
        ];

        for (const cmd of commands) {
            await CdpSetupService.execPromise(cmd);
        }
        console.log('ReRevolve CDP: HKCU Antigravity Boost 등록 완료');
    }

    /**
     * HKCU 우클릭 "Antigravity (Original)" CDP 오버라이드
     */
    private static async registerOriginalContextMenu(antigravityExe: string): Promise<void> {
        const commands = [
            `reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\2_AntigravityOriginal" /ve /d "Antigravity (CDP)" /f`,
            `reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\2_AntigravityOriginal" /v "Icon" /d "${antigravityExe}" /f`,
            `reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\2_AntigravityOriginal\\command" /ve /d "\\"${antigravityExe}\\" ${CDP_ARG} \\"%V\\"" /f`,
        ];

        for (const cmd of commands) {
            await CdpSetupService.execPromise(cmd);
        }
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

        // PowerShell로 바로가기 수정
        const psScript = `
$WshShell = New-Object -ComObject WScript.Shell
$searchPaths = @(${searchPaths.map(p => `"${p.replace(/\\/g, '\\\\')}"`).join(',')})
$modified = 0

foreach ($searchPath in $searchPaths) {
    if (!(Test-Path $searchPath)) { continue }
    $shortcuts = Get-ChildItem -Path $searchPath -Recurse -Filter "*.lnk" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "*Antigravity*" -and $_.Name -notlike "*Uninstall*" }
    
    foreach ($shortcutFile in $shortcuts) {
        try {
            $shortcut = $WshShell.CreateShortcut($shortcutFile.FullName)
            $args = $shortcut.Arguments
            if ($args -match "remote-debugging-port") { continue }
            $shortcut.Arguments = "${CDP_ARG} " + $args
            $shortcut.Save()
            $modified++
            Write-Host "Updated: $($shortcutFile.Name)"
        } catch { }
    }
}
Write-Host "Modified $modified shortcut(s)"
`;
        await CdpSetupService.execPromise(
            `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`
        );
        console.log('ReRevolve CDP: 바로가기 업데이트 완료');
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

    private static execPromise(cmd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            exec(cmd, { shell: 'powershell.exe' }, (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(`${err.message}\n${stderr}`));
                } else {
                    resolve(stdout);
                }
            });
        });
    }
}
