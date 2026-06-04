# ReRevolve Quota Manager Changelog

## [8.4.0] - 2026-05-20
- **[치명적 수정]** Antigravity IDE 기동 시 새하얀 화면(White Screen) 프리징 버그 완전 해결
  - 원인: `sql.js` (WASM 기반 SQLite) 동기 로딩이 Extension Host 메인 스레드를 블로킹
  - 해결: 초경량 직접 버퍼 파서(`direct-db-reader.ts`) 도입으로 기동 시 WASM 의존성 0% 달성
  - `token-service.ts`: 모든 읽기 작업을 직접 버퍼 스캔 + Regex 필드 추출로 전면 교체
  - `account-switcher.ts`: 읽기는 직접 버퍼 파서, 쓰기(계정 전환)만 sql.js 지연 로딩(Lazy Loading) 
  - 기동 시간: ~∞(무한 대기) → 0.1ms 미만으로 개선
- **개선**: SQLite Overflow Page로 JSON이 분할되어도 정규식으로 앞부분 필드를 안전하게 추출
- **개선**: 파일 버퍼 mtime 기반 캐시로 반복 읽기 시 I/O 최소화

## [8.3.39] - 2026-05-08
- **수정**: 계정 전환 시 `antigravityAuthStatus`와 `antigravityUnifiedStateSync.oauthToken`뿐 아니라 `jetskiStateSync.agentManagerInitState`의 OAuth field도 저장된 계정 토큰으로 교체
- **개선**: 재시작 후 `jetskiStateSync.agentManagerInitState`에 남은 이전 계정 토큰이 Language Server/프로필 상태를 원복시키는 경우를 줄임

## [8.3.38] - 2026-05-08
- **수정**: 무료 비활성 계정은 원격 API의 가짜 `100%` 응답으로 덮어쓰지 않고 마지막 활성 상태 캐시를 유지
- **수정**: 무료 비활성 계정의 추정 재충전 시간이 지나면 로컬에서 `100% / 7일 0시간`으로 재설정
- **수정**: Auto-Retry는 `Retry` 버튼만 처리하도록 좁히고 `Continue`, `Send command input?` 승인 자동 반응 제거

## [8.3.37] - 2026-05-07
- **개선**: 하단 상태바를 `Accept`와 `Retry` 토글로 분리하여 Retry/Continue 복구 자동화 상태를 바로 확인하고 클릭 전환 가능
- **수정**: Auto-Retry OFF 상태에서도 `Retry`, `Continue`, `Send command input?` 복구 승인이 실행될 수 있던 경로 차단
- **수정**: CDP 주입 스크립트의 Accept/Retry 플래그를 명시적 `true`일 때만 동작하도록 강화하여 오래된 주입 상태의 기본 ON 동작 방지

## [8.3.36] - 2026-05-07
- **기능**: Auto-Accept와 Auto-Retry 토글 분리 (`Ctrl+Alt+Shift+A`, `Ctrl+Alt+Shift+R`)
- **기능**: 계정 스마트 정렬 추가 — `valcano5740`, `valcjapan`, `valcano0001~0019` 유료 우선, 무료/기타 이름순
- **개선**: 스마트 정렬 적용 버튼으로 현재 계정 순서를 저장할 수 있도록 추가

## [8.3.35] - 2026-05-07
- **수정**: AI Credit Overage 사용 중인 Claude/GPT 모델이 100%로 표시되던 문제 수정
- **개선**: 로컬 LS 응답에서 `quotaInfo` 또는 `remainingFraction`이 비어 있어도 Claude/GPT 계열의 소진/크레딧 사용 신호는 0%로 해석
- **개선**: 사이드바와 상태바에 AI 크레딧 사용 중 표시를 추가

## [8.3.34] - 2026-05-07
- **수정**: Retry/Continue 자동 복구가 연속 입력되어 `[unknown] executor has not processed the previous input yet` 오류를 유발하던 문제 완화
- **개선**: Retry, Continue, `Send command input?` Accept에 DOM 재렌더링과 무관한 전역 복구 액션 잠금을 추가
- **개선**: executor busy 문구가 보이면 30초 동안 복구성 자동 클릭을 중단하도록 보호

## [8.3.33] - 2026-05-06
- **기능**: 저장된 refresh token으로 새 access token을 발급해 `antigravityUnifiedStateSync.oauthToken`까지 교체하는 원클릭 계정 전환 경로 추가
- **수정**: 기존 스냅샷 전환이 `antigravityAuthStatus`만 바꿔 Antigravity 1.23+에서 다시 원복되던 문제 완화
- **개선**: 계정 전환 후 Language Server를 종료하고 창을 다시 불러와 새 OAuth 상태로 LS가 재시작되도록 처리

## [8.3.32] - 2026-05-06
- **수정**: Antigravity 1.23/1.107 계열에서 `--agent_port`가 사라진 문제 대응 — Language Server 프로세스의 실제 Listen 포트를 확인하고 `GetUserStatus` 응답이 성공하는 HTTPS/HTTP 포트를 자동 선택
- **수정**: `antigravity_auth`/`state.vscdb`의 stale 계정보다 실제 Language Server 응답을 우선하여 활성 계정 고착 문제 완화
- **수정**: TokenService와 QuotaService가 서로 다른 LanguageServerClient 캐시를 쓰던 문제 해결
- **개선**: 활성 계정은 토큰이 없어도 로컬 LS 쿼터 조회를 먼저 시도하여 무료 활성 계정 표시 실패를 줄임

## [8.3.26] - 2026-04-20
- **조사**: Gemini 쿼터 100% 고정 원인 추적용 디버그 로그 강화 — rawModels 전체를 model key + label + remaining 형태로 출력
- **개선**: GROUPS 키워드 확장 (`gemini-pro`, `3.1-pro`, `gemini_3_pro` 등 추가)
- **수정**: `quotaInfo` 없는 모델도 리스트에 포함 (이전에는 필터링되어 누락)

## [8.3.25] - 2026-04-17
- **치명적 수정**: Retry 자동 클릭이 한 번도 작동하지 않았던 근본 원인 해결 — 정규식 `/\\\\bretry\\\\b/i`가 이중 이스케이프되어 리터럴 `\\b` 매칭 시도 (단어 경계 `\b`가 아님). 어떤 Retry 텍스트도 매칭 불가능했음
- **개선**: Gemini 쿼터 디버그 로그 추가 — 실제 API 모델명과 GROUPS 키워드 매칭 결과를 출력하여 100% 고정 원인 추적
- **개선**: 하단 상태바 재디자인 — `C:75% | G:80%` → `🟣75% 🔵80%` 이모지 기반으로 변경, 직관적 구분
- **개선**: Retry 섹션 1.55 디버그 로그 추가 (진입/버튼 발견 수 확인용)

## [8.3.24] - 2026-04-16
- **기능**: 사이드바에 Gemini Pro 쿼터를 Claude 옆에 나란히 표시 (`C 75%` `G 80%` 형태), 모델명 라벨 포함
- **기능**: 하단 상태바에도 Gemini Pro 쿼터 추가 표시 (`C:75% | G:80%` 형태)
- **개선**: quota-badges 컨테이너 CSS 추가로 뱃지 2개가 깔끔하게 정렬

## [8.3.23] - 2026-04-15
- **수정**: Retry 버튼 자동 클릭이 작동하지 않던 치명적 버그 해결 — `ACTION_NODE_SELECTOR`가 `button`, `a` 태그만 검색하여 VS Code/Cursor의 `div`/`span` 기반 가상 버튼(`.monaco-button` 등)을 감지하지 못했던 문제. 셀렉터 범위를 대폭 확장

## [8.3.22] - 2026-04-15
- **개선**: Retry 자동 클릭 시 에러 상황 감지 조건 대폭 확장
  - 기존 2가지(`terminated due to error`, `agent terminated`)에서 15가지 에러 패턴 추가 (`high traffic`, `something went wrong`, `request failed`, `rate limit`, `try again`, `timed out` 등)
  - CSS 클래스에 `error`, `warning`, `failed`, `alert`가 포함된 요소도 에러 컨텍스트로 감지
  - 최후 폴백: Retry 버튼이 형제 액션 버튼 없이 단독으로 존재할 경우, 명시적 에러 컨텍스트 없이도 자동 클릭 허용

## [8.3.21] - 2026-04-15
- **수정**: 유료 계정이 일시적인 API 오류로 인해 무료 계정으로 오인되어 강등되는 문제 방지 (`_freeDemotionCount` 카운터 도입, 연속 3회 무료 판정 시에만 실제 강등 반영)
- **수정**: 현재 활성화된(Active) 무료 계정은 자동으로 잠금(Locked) 상태가 되지 않도록 예외 처리 추가

## [8.3.19] - 2026-04-15
- **기능**: "Send command input?" 프롬프트 창이 떴을 때 'Accept' 버튼을 자동으로 클릭하는 자동 승낙 조건 추가

## [8.3.18] - 2026-04-13
- **수정**: 'Continue' 버튼 자동 클릭 시, 중복/잘못된 요소 클릭으로 인해 다이얼로그 모달이 무한히 깜빡거리는 오류 해결 (전역 스캔 조건 강화 및 우선순위 조정)

## [8.3.0] ~ [8.3.17]
- 쿼터 새로고침 최적화 및 프리징 복구, 토큰 자동 동기화 기능 안정화, 계정 전환 UI 개선, 자동 승낙 스크립트 고도화 (이전 변경 내역 생략)
