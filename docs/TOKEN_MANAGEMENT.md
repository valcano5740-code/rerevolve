# ReRevolve 토큰 및 계정 관리 기술 문서

## 개요
ReRevolve 확장프로그램의 토큰 관리 및 계정 전환 기능 기술 문서.

---

## 1. Antigravity 데이터 저장소

### 1.1 state.vscdb 위치
```
Windows: %APPDATA%/Antigravity/User/globalStorage/state.vscdb
```

### 1.2 주요 키

| 키 | 용도 |
|---|---|
| `antigravityAuthStatus` | 현재 로그인 계정 정보 (email, apiKey) - JSON |
| `antigravityUnifiedStateSync.oauthToken` | OAuth 토큰 정보 - Base64 Protobuf |
| `jetskiStateSync.agentManagerInitState` | 에이전트 상태 - Base64 Protobuf |

---

## 2. 토큰 캡처

### 2.1 현재 구현 (v6.3.4)
**파일**: `token-service.ts` → `captureCurrentToken()`

**Access Token 소스**: `antigravityAuthStatus.apiKey`

**Refresh Token 소스**: `antigravityUnifiedStateSync.oauthToken` (추출 실패 중 - 해결 필요)

### 2.2 토큰 저장 구조
```typescript
interface StoredCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  email: string;
  createdAt: number;
}
```

### 2.3 버전별 변경 사항

| 버전 | 변경 내용 |
|------|----------|
| v6.3.2 | Access Token을 antigravityAuthStatus.apiKey에서 추출 |
| v6.3.3 | Refresh Token을 antigravityUnifiedStateSync.oauthToken에서 추출 시도 |
| v6.3.4 | 클릭한 계정에 저장, 불일치 시 경고만 표시 |

---

## 3. Refresh Token 추출

### 3.1 현재 상태
**문제**: "(액세스 토큰만)" 표시 - Refresh Token 추출 실패

**해결 필요**

---

## 4. 계정 전환

### 4.1 스냅샷 저장
**파일**: `account-switcher.ts` → `saveSnapshot()`

**저장 내용**: `antigravityAuthStatus` 전체 JSON

**저장 위치**: VSCode SecretStorage

### 4.2 스냅샷 복원
**파일**: `account-switcher.ts` → `restoreSnapshot()`

**동작**: `state.vscdb`의 `antigravityAuthStatus` 키에 스냅샷 복원

---

## 5. 쿼터 조회

**엔드포인트**: `https://web2.cursor.sh/auth/loadCodeAssist`

**인증**: Bearer Token (Access Token)

---

## 6. 향후 작업

- [ ] Refresh Token 추출 문제 해결
- [ ] UI 버튼 이름 변경
