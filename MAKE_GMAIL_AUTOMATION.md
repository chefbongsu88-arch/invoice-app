# Make + Gmail → Invoice Tracker 자동화 가이드

## 개요
Make를 사용하여 Gmail에서 인보이스 메일을 자동으로 감지하고, Claude AI로 분석한 후 Google Sheets에 자동 입력하는 워크플로우입니다.

## Make 시나리오 구성 (순서대로)

### ① Gmail 트리거 설정
1. Make에서 새 시나리오 생성
2. **Gmail → Watch Emails** 모듈 추가
3. Gmail 계정 연결 후 인보이스 메일이 오는 폴더/라벨 지정
4. 실행 주기: 15분마다 또는 즉시(webhook)

### ② Router로 필터링
1. **Router** 모듈 추가
2. 필터 조건 설정:
   - Subject contains "invoice" OR "factura" OR "recibo"
   - 인보이스가 아닌 메일은 해당 경로에서 중단

### ③ 첨부파일 추출
1. **Gmail → Get Attachments** 모듈
2. PDF 또는 이미지 파일만 필터링
3. Base64로 인코딩

### ④ Claude AI로 분석 (핵심)
1. **HTTP → Make a request** 모듈로 Anthropic API 직접 호출

**설정:**
```
Method: POST
URL: https://api.anthropic.com/v1/messages
Headers:
  - x-api-key: YOUR_ANTHROPIC_API_KEY
  - content-type: application/json

Body (JSON):
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": "{{attachment_base64}}"
          }
        },
        {
          "type": "text",
          "text": "이 인보이스에서 다음 정보를 JSON 형식으로 추출해줘:\n{\n  \"vendor\": \"거래처명\",\n  \"invoiceNumber\": \"인보이스 번호\",\n  \"date\": \"YYYY-MM-DD 형식\",\n  \"total\": \"총액 (숫자만)\",\n  \"iva\": \"IVA/VAT (숫자만)\",\n  \"base\": \"Base amount (숫자만)\",\n  \"category\": \"카테고리 (Vegetables/Meat/Supplies 등)\",\n  \"currency\": \"통화 (EUR/USD 등)\"\n}"
        }
      ]
    }
  ]
}
```

### ⑤ JSON 파싱 → 컬럼 매핑
1. **JSON → Parse JSON** 모듈로 Claude 응답 파싱
2. 스프레드시트 컬럼에 매핑:
   - Source: "Email"
   - Invoice #: invoiceNumber
   - Vendor: vendor
   - Date: date
   - Total (€): total
   - IVA (€): iva
   - Base (€): base
   - Category: category
   - Currency: currency
   - Image URL: (첨부파일 URL)

### ⑥ Google Sheets 입력
1. **Google Sheets → Add a Row** 모듈
2. 스프레드시트 ID: `1-6DV0NCrWGRiTyQV_WWS_uHC6ALfDrFJT9PVKO9eq5E`
3. 시트명: `2026 Invoice tracker`
4. 각 컬럼에 값 매핑

## 주의사항

1. **Claude API Key**: Anthropic 계정에서 발급받아야 함
2. **이미지 형식**: PDF는 먼저 이미지로 변환 필요 (Make의 PDF to Image 모듈 사용)
3. **오류 처리**: 분석 실패 시 알림 설정 권장
4. **중복 방지**: Invoice Number로 중복 확인 로직 추가 권장

## 테스트 방법

1. Make 시나리오 저장 후 활성화
2. 테스트 인보이스 메일 전송
3. 15분 이내에 Google Sheets에 자동 입력되는지 확인
4. 필요시 각 모듈의 로그 확인

## 비용 고려사항

- **Make**: 무료 플랜 포함 (월 100회 실행)
- **Claude API**: 사용량 기반 (약 $0.003/이미지)
- **Google Sheets**: 무료

## 향후 개선

1. 이미지 품질 자동 조정
2. 다국어 인보이스 지원
3. 특정 거래처별 자동 분류
4. 월별 요약 이메일 발송
