# ReRevolve Git Workflow

## 버전 관리 규칙

### 브랜치 전략
- `main`: 안정된 릴리스 버전
- `dev`: 개발 중인 기능
- `feature/*`: 새 기능 개발

### 커밋 메시지 형식
```
[타입] 제목

본문 (선택)
```

타입:
- `feat`: 새 기능
- `fix`: 버그 수정
- `refactor`: 리팩토링
- `docs`: 문서 수정
- `chore`: 기타 작업

### 릴리스 절차
1. `package.json` 버전 업데이트
2. `CHANGELOG.md` 업데이트
3. 커밋: `[release] v버전`
4. 태그: `git tag v버전`
5. 푸시: `git push origin main --tags`

### 현재 버전
- v6.0.0: Account Switcher 기능 추가

### TODO (다음 버전)
- [ ] 스냅샷 SecretStorage 이전
- [ ] 토큰 캡처 + 스냅샷 통합
- [ ] UI 개선

---

## 릴리스 스크립트 (AI용)
버전 업데이트 시 다음 단계 수행:
1. `package.json`의 version 필드 업데이트
2. `CHANGELOG.md` 업데이트
3. `git add . && git commit -m "[release] vX.X.X"`
4. `git tag vX.X.X`
5. `git push origin master --tags`
6. `npx vsce package` 실행
