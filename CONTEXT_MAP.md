# ReRevolve Project Memory

## 📌 Shared Cluster (Global Context)

### state.vscdb 위치
```
Windows: %APPDATA%/Antigravity/User/globalStorage/state.vscdb
```

### 주요 키
| 키 | 용도 | 형식 |
|---|---|---|
| `antigravityAuthStatus` | 현재 로그인 계정 (email, apiKey) | JSON |
| `antigravityUnifiedStateSync.oauthToken` | OAuth 토큰 정보 | Base64 Protobuf |
| `jetskiStateSync.agentManagerInitState` | 에이전트 상태 | Base64 Protobuf |

---

## 🔑 Cluster: Token Management

### Current Understanding
- [Verified] Access Token은 `antigravityAuthStatus.apiKey`에서 추출
- [Verified] Refresh Token은 `antigravityUnifiedStateSync.oauthToken` → fallback: `jetskiStateSync`
- [Verified] 저장 위치: VSCode globalState (`rerevolve.token.{email}`) ← v6.6.0에서 SecretStorage→globalState 이전
- [Verified] 디버그 파일: `~/.rerevolve-debug/{email}.json`
- [v6.4.0] **Refresh Token만 저장** - Access Token은 쿼터 조회 시 발급
- [v6.4.0] **Language Server API**로 활성 계정 실시간 감지 (3회 재시도 → vscdb fallback)
- [v6.6.0] **Export/Import에 refresh token 포함** - 기기 간 이동 가능
- [v6.6.0] **토큰 캡처: state.vscdb → OAuth 인증 전환** - 계정별 정확한 refresh token 보장
- [v6.6.3] **OAuth loopback redirect** 완성 - OOB 폐지 대응, 로컬 HTTP 서버로 인증 코드 자동 수신
  - ⚠️ gotcha: `server.close()` 후 `server.address()` = null → 포트를 외부 변수에 미리 저장 필수
  - ⚠️ gotcha: 브라우저 favicon.ico 요청 → code/error 없는 요청은 무시 처리 필요

### Key Decisions
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-05 | oauthToken을 primary로 사용 | jetski보다 안정적 |
| 2026-02-05 | 클릭한 계정에 저장 | 활성 계정 감지 불안정 |
| 2026-02-06 | 자동 복구 기능 제거 | 잘못된 계정 토큰 저장 버그 |
| 2026-02-06 | Refresh Token만 저장 | 안정적 토큰 관리 |
| 2026-02-06 | Language Server API 도입 | 실시간 활성 계정 감지 |
| 2026-02-10 | OAuth 캡처 전환 | state.vscdb의 refresh token 계정 불일치 문제 |
| 2026-02-10 | **OOB → loopback redirect** | Google OOB(`urn:ietf:wg:oauth:2.0:oob`) 폐지됨 → `http://localhost` 방식 |
| 2026-02-10 | VS Code 명령어 자동 accept 제거 | Ctrl+Alt+P 시 열린 창이 닫히는 부작용 |
| 2026-02-10 | Accept 스크립트 iframe 탐색 추가 | Reddit 발견: Accept 버튼은 iframe 내부 `bg-ide-button-bac` 클래스 |

### Rejected Approaches
- [Rejected] tryAutoRecovery → 활성 계정 감지 불안정으로 잘못된 토큰 저장
- [Rejected] jetski-only 추출 → 불완전한 토큰 반환
- [Rejected] Access Token 저장 → 만료 관리 복잡
- [Rejected] state.vscdb에서 refresh token 추출 → 계정 전환 시 갱신 안 됨
- [Rejected] **OOB OAuth** (`urn:ietf:wg:oauth:2.0:oob`) → Google 폐지 (400 invalid_request)

---

## 🔄 Cluster: Account Switching

### Current Understanding
- [Estimated] 스냅샷 저장/복원은 구현됨, 검증 필요
- [Estimated] `state.vscdb` 직접 수정 방식

### Key Decisions
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-01 | vscdb 직접 수정 | 폴더 복사보다 효율적 |

---

## 🤖 Cluster: Auto Accept (내부 명령어 + 설정 토글)

### Current Understanding (v6.10.0)
- **[v6.7.0+] CDP 완전 제거** — VS Code 내부 명령어만 사용
- **[v6.9.0] Accept 명령어 10개** (Hunk, Supercomplete, Tab Jump 등)
- **[v6.9.0] 설정 자동 주입/원복** (ON 시 5개 설정 + browserAllowlist.txt)
- 700ms 인터벌 폴링, 비차단 실행 (`await` 없음)
- globalState에 ON/OFF 상태 저장 (재시작 시 복원)
- 토글 시 상태바 + 알림 메시지 표시

### Accept 명령어 (10개)
```
antigravity.agent.acceptAgentStep              - 에이전트 스텝 승인 (Accept All)
antigravity.terminalCommand.accept              - 터미널 명령 승인
antigravity.command.accept                      - 일반 명령 승인
antigravity.prioritized.agentAcceptAllInFile    - 파일 내 전체 변경 수락
antigravity.prioritized.agentAcceptFocusedHunk  - 포커스된 Hunk 수락
antigravity.prioritized.supercompleteAccept     - Supercomplete 수락
antigravity.acceptCompletion                    - 자동완성 수락
antigravity.prioritized.terminalSuggestion.accept - 터미널 제안 수락
antigravity.prioritized.tabJumpAccept           - Tab Jump 수락
antigravity.cascade.acceptSuggestedAction        - Cascade 제안 수락
```

### 관리되는 설정 (ON 시 주입, OFF 시 원복)
| 설정 키 | ON 값 | 효과 |
|---|---|---|
| `cached.allowAgentAccessNonWorkspaceFiles` | `true` | 워크스페이스 외부 파일 접근 |
| `cached.terminalAutoExecutionPolicy` | `autoExecute` | 터미널 명령 자동 실행 |
| `cached.allowCascadeAccessGitignoreFiles` | `true` | gitignore 파일 접근 |
| `cached.artifactReviewPolicy` | `autoApply` | 아티팩트 자동 적용 |
| `security.workspace.trust.untrustedFiles` | `open` | 신뢰되지 않은 파일 열기 |

### browserAllowlist.txt (Auto-Accept ON 시 자동 생성)
- 경로: `~/.gemini/antigravity/browserAllowlist.txt`
- 내용: `http://127.0.0.1:*/*`, `http://localhost:*/*`, `https://*/*`, `http://*/*`
- OFF 시 삭제

### Key Decisions
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-06 | VS Code 명령어 1순위 도입 | CDP DOM 클릭보다 안정적 |
| 2026-02-12 | **CDP 전면 제거** | Electron 네이티브 UI 접근 불가 |
| 2026-02-19 | 명령어 3개→10개 확장 | 모든 수락 UI 자동 처리 |
| 2026-02-19 | 설정 토글 연동 | ON 시 자동 주입/OFF 시 원복 |

### 참고 자료
| 프로젝트 | 설명 |
|----------|------|
| [pesosz/antigravity-auto-accept](https://marketplace.visualstudio.com/items?itemName=pesosz.antigravity-auto-accept) | 단순 명령어 실행 방식 참고 |
| [Ricco6/always-accept-antigravity](https://github.com/Ricco6/always-accept-antigravity) | 명령어 발견 참고 |

---

## 📊 Cluster: Quota API

### Current Understanding
- [Verified] 엔드포인트: `https://web2.cursor.sh/auth/loadCodeAssist`
- [Verified] 인증: Bearer Token (Access Token)

---

## 🔧 Cluster: Toolkit for Antigravity (참고용)

### Extension Info
- **이름**: Toolkit for Antigravity (이전: Antigravity Panel)
- **식별자**: `n2ns.antigravity-panel`
- **버전**: 2.5.11
- **다운로드**: 82k+
- **개발사**: N2N Synthetics
- **라이선스**: Apache 2.0
- **저장소**: https://github.com/n2ns/antigravity-panel

### 특징
- Quota Monitoring (실시간)
- Usage Analytics (차트)
- Cache Management
- Native Integration

### Current Understanding
- [Verified] **Language Server HTTP API로 직접 통신** - 파일 읽기 아님!
- [Verified] `ProcessFinder`로 Language Server 프로세스 자동 감지
- [Verified] 포트 + CSRF 토큰 추출하여 HTTP POST 요청
- [Verified] 갱신 주기: `dashboard.refreshRate` 설정값 (기본 90초)
- [Verified] Auto-Accept: 800ms 기본 간격, 설정 가능 (200~5000ms)

### 기술 분석 (v6.10.0 기준)
| 항목 | ReRevolve | Toolkit |
|------|-----------|---------|
| **쿼터 감지** | LS API + Refresh Token → 별도 API | LS `GetUserStatus` 응답에서 직접 추출 |
| **계정 감지** | LS API (`GetUserStatus`) + vscdb fallback | LS API 응답 |
| **통신 방식** | HTTP (localhost:PORT) | HTTP (localhost:PORT) |
| **반응 속도** | 초기 500ms → 15초 재시도 | refreshRate 설정값 (90초) |
| **서버 감지** | ProcessFinder (프로세스 스캔) | ProcessFinder (프로세스 스캔) |

### 소스 참조
- **저장소**: https://github.com/n2ns/antigravity-panel
- **QuotaService**: `src/model/services/quota.service.ts`
- **ProcessFinder**: `src/shared/platform/process_finder.ts`
- **API 경로**: `system.apiPath` 설정값 (loadCodeAssist 유사)

---

## ✅ TODO

- [x] Toolkit 소스 분석하여 실제 감지 방식 확인 (동일한 `GetUserStatus` API 사용)
- [ ] 계정 전환 기능 검증
- [ ] UI 버튼 이름 변경 ("토큰 캐프처" → "계정 저장")
- [ ] 초기 상태바 쿼터 표시 지연 문제 해결 (초기 재시도 로직 강화)

---

## 📜 History

### v6.7.0 (2026-02-12)
- **Auto-Accept 전면 개편**: CDP 제거, pesosz 방식(VS Code 내부 명령어 직접 호출) 적용
- **Boost 런처 수정**: `--remote-debugging-port` 옵션 제거 (계정 전환 세션 고착 문제 해결)
- **Dead Code 제거**: OOB OAuth, CDP 관련 코드 삭제

### v6.7.1 (2026-02-13)
- **Accept All 명령어 수정**: pesosz 확장의 `antigravity.terminal.accept`는 실제 존재하지 않는 명령어
  - 올바른 명령어: `antigravity.terminalCommand.accept` (Antigravity 내장 확장 `package.json` 직접 확인)
- **`terminalCommand.run` 제거**: 승인이 아닌 실행 명령이라 자동 호출 위험
- **ON/OFF 상태 저장**: `globalState`로 Auto-Accept 상태 유지 (재시작해도 복원)
- **알림 팝업 제거**: `showInformationMessage` 제거 (토글 시 불필요한 팝업 방지)
- **폴링 최적화**: 500ms→1000ms, await→비차단 `.then()`
- ⚠️ **VSIX 빌드 주의**: `--no-dependencies` 사용 금지 (node_modules 누락 → 416KB로 축소되어 확장 로딩 실패)

### v6.7.2 (2026-02-13)
- **활성 계정 실시간 감지 개선**
  - LS 캐시 30s → 5s (계정 전환 후 빠르게 재감지)
  - 쿼터 자동 갱신 60s → 15s
  - `state.vscdb` 파일 변경 감시 (`fs.watch`) → 계정 전환 2초 내 즉시 감지
  - `TokenService.invalidateCache()` 추가 (LS 캐시 즉시 무효화)
- **재충전 완료 실시간 감지**
  - `QuotaResult.claudeResetTimeRaw` (원본 ISO 시간) 추가
  - 사이드바: 현재시간 기준 남은 시간 실시간 계산, 리셋 경과 시 '✅ 충전됨!' 표시
  - 상태바: 5초마다 로컬 시간 비교 (API 호출 없음, 자원 소모 제로)
- **다중 창 쿼터 동기화**
  - `quotas.json` 파일 감시 (`fs.watch`) → 다른 창 갱신 시 1초 내 자동 반영
  - `refreshAccount`에서 30초 내 갱신 데이터 API 스킵 (중복 호출 방지)
  - `savingNow` 플래그로 자기 저장 시 감시 무시

### v6.8.0 (2026-02-19)
- **Auto-Accept 확장**: Accept 명령어 3개 → 10개 (Hunk, Supercomplete, Tab Jump 등)
- **설정 자동 주입/원복**: ON 시 5개 설정 settings.json 주입, OFF 시 원복
- **browserAllowlist.txt** 자동 생성/삭제
- **폴링 최적화**: 1000ms → 700ms
- ⚠️ 계정 감지 기능 제거됨 (state.vscdb 감시, 15초 갱신, 재충전 체크)

### v6.9.0 (2026-02-19)
- **통합 버전**: v6.7.5 안정성 + v6.8.0 기능
- ⚠️ 여전히 계정 감지 기능 미복원 (60초 간격만 유지)

### v6.10.0 (2026-02-23)
- **v6.9.0 + v6.7.11 안정성 통합**
- **accounts.json 데이터 소실 방지**: load() .bak 복구 + save() 빈 배열 차단 + 자동 백업
- **Promise.all 안전장치**: hasToken() `.catch(() => false)` 복원
- **계정 감지 성능 복원**:
  - state.vscdb 파일 감시(fs.watch) 복원 (2초 디바운스)
  - 쿼터 갱신 60초 → 15초 복원
  - 재충전 로컬 체크(checkRechargeLocal) 5초 복원
- **LICENSE 파일 추가** (vsce package y/N 방지)

