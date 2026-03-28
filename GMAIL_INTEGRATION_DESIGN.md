# Gmail Integration Architecture

## 목표

Invoice Tracker 앱에서 Gmail 이메일을 자동으로 감지하고, AI로 인보이스 데이터를 추출한 후, Google Sheets의 모든 시트에 자동으로 저장하는 기능 구현.

---

## 현재 상태

### ✅ 이미 구현된 기능
1. **Gmail OAuth 연결** (`app/(tabs)/gmail.tsx`)
   - Google 계정 로그인
   - 토큰 저장 (AsyncStorage)
   - 이메일 자동 감지

2. **AI 데이터 추출** (`server/routers.ts`)
   - `parseEmailInvoice`: 이메일 본문에서 인보이스 정보 추출
   - LLM 사용해서 JSON 형식으로 변환

3. **Google Sheets 내보내기** (`server/routers.ts`)
   - `exportToSheets`: Service Account로 인증
   - 1개 시트에만 데이터 저장 가능

### ❌ 문제점
1. **수동 저장**: 사용자가 "Save to Receipts" 버튼 클릭 필요
2. **1개 시트만**: Monthly 시트에만 저장
3. **자동 동기화 없음**: 15분마다 자동 확인 안 됨
4. **Make.com 문제**: 이메일 전체 본문이 그대로 저장됨

---

## 개선 계획

### 1단계: 자동 저장 기능 추가

**목표**: Gmail 이메일 → 자동으로 Receipts 탭에 저장

**구현**:
- Settings에서 "Auto-save Gmail emails" 토글 추가
- 활성화하면 새 이메일 자동 저장
- 비활성화하면 현재처럼 수동 저장

**파일 변경**:
- `app/(tabs)/gmail.tsx`: 자동 저장 옵션 추가
- `app/(tabs)/settings.tsx`: 토글 추가
- `server/routers.ts`: 자동 저장 로직 추가

---

### 2단계: 모든 시트에 자동 내보내기

**목표**: Receipts 저장 → 자동으로 모든 Google Sheets 시트에 저장

**구현**:
- `exportToSheets` 함수 개선
- 여러 시트에 동시 저장:
  - Monthly (월별)
  - Q1, Q2, Q3, Q4 (분기별)
  - Meat_Analysis (고기 분석)
  - Dashboard (대시보드)
  - Executive_Summary (투자자 보고서)

**파일 변경**:
- `server/routers.ts`: `exportToSheets` 개선
- `server/sheets-automation-enhanced.ts`: 자동화 로직 활용

---

### 3단계: 배경 동기화

**목표**: 앱이 백그라운드에서 15분마다 Gmail 확인

**구현**:
- Expo TaskManager 사용
- 15분마다 자동 실행
- 새 이메일 자동 처리

**파일 변경**:
- `app/_layout.tsx`: 배경 작업 등록
- `server/routers.ts`: 배경 동기화 엔드포인트

---

## 데이터 흐름

```
Gmail 이메일
    ↓
[1] fetchGmailInvoices (Gmail API)
    ↓
이메일 목록 (subject, from, body)
    ↓
[2] parseEmailInvoice (AI LLM)
    ↓
추출된 데이터 (JSON)
    ↓
[3] addInvoice (로컬 저장)
    ↓
Receipts 탭에 표시
    ↓
[4] exportToSheets (자동 또는 수동)
    ↓
Google Sheets (모든 시트)
    ↓
✅ 완료
```

---

## 구현 순서

1. **1단계**: 자동 저장 기능 (가장 간단)
2. **2단계**: 모든 시트에 자동 내보내기 (중간)
3. **3단계**: 배경 동기화 (가장 복잡)

---

## 사용자 경험

### 현재 (수동)
1. "Sync Gmail" 클릭
2. 이메일 목록 표시
3. "Parse with AI" 클릭
4. "Save to Receipts" 클릭
5. "Export to Sheets" 클릭 (수동)

### 개선 후 (자동)
1. Settings에서 "Auto-save Gmail emails" 활성화
2. 앱이 15분마다 자동 확인
3. 새 이메일 자동 저장
4. 자동으로 모든 Google Sheets 시트에 저장
5. 완료! ✅

---

## 기술 스택

- **Frontend**: React Native, Expo
- **Backend**: tRPC, Node.js
- **AI**: LLM (multimodal)
- **APIs**: Gmail API, Google Sheets API
- **Auth**: Google OAuth, Service Account
- **Storage**: AsyncStorage (토큰), Google Sheets (데이터)
