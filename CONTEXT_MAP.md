# ReRevolve Project Memory

## 🔑 Token Management

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

### 토큰 캡처 (v6.3.5)
- **Access Token**: `antigravityAuthStatus.apiKey`
- **Refresh Token**: 
  1. `antigravityUnifiedStateSync.oauthToken` (우선)
  2. `jetskiStateSync.agentManagerInitState` (fallback)
- **저장 위치**: VSCode SecretStorage (`rerevolve.token.{email}`)
- **디버그 파일**: `~/.rerevolve-debug/{email}.json`

### 토큰 저장 구조
```typescript
interface StoredCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email: string;
  createdAt: number;
}
```

---

## 🔄 Account Switching

### 스냅샷 저장
- **파일**: `account-switcher.ts` → `saveSnapshot()`
- **내용**: `antigravityAuthStatus` 전체 JSON
- **위치**: VSCode SecretStorage (`rerevolve.snapshots`)

### 스냅샷 복원
- **파일**: `account-switcher.ts` → `restoreSnapshot()`
- **동작**: `state.vscdb`의 `antigravityAuthStatus`에 복원

---

## 📊 Quota API

- **엔드포인트**: `https://web2.cursor.sh/auth/loadCodeAssist`
- **인증**: Bearer Token (Access Token)

---

## 📝 Decision Log

| 날짜 | 버전 | 변경 내용 |
|------|------|----------|
| 2026-02-05 | v6.3.2 | Access Token을 `antigravityAuthStatus.apiKey`에서 추출 |
| 2026-02-05 | v6.3.3 | Refresh Token을 `oauthToken`에서 먼저 시도 |
| 2026-02-05 | v6.3.4 | 클릭한 계정에 저장, 불일치 시 경고만 표시 |
| 2026-02-05 | v6.3.5 | 디버그 JSON 파일 저장 기능 추가 |

---

## 🤖 Auto Accept (CDP 기반)

### 동작 방식
- CDP(Chrome DevTools Protocol)로 Antigravity 창에 연결
- 화면에서 버튼을 찾아 자동 클릭

### 버튼 선택자 (v6.3.6)
```javascript
'button, [class*="button"], [class*="btn"], [role="button"], a[class*="action"], div[class*="action"], span[class*="action"]'
```

### Accept 패턴
```javascript
['accept', 'run', 'retry', 'apply', 'execute', 'confirm', 'allow once', 'allow']
```

### Reject 패턴 (클릭하지 않음)
```javascript
['skip', 'reject', 'cancel', 'close', 'refine', 'auto-accept', 'rerevolve', 'quota']
```

---

## ✅ TODO

- [ ] UI 버튼 이름 변경 ("토큰 캡처" → "계정 저장")
- [ ] SonarQube 경고 수정