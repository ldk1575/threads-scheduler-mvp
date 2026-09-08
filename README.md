# Threads 텍스트 예약 발행 MVP

> 예약해 두면 정해진 시각에 링크가 박힌 글이 저절로 올라간다.
> **같은 글을 두 번 눌러도 한 번만 올라간다.**

Threads Graph API 위에 **멱등 발행 큐**와 **콘텐츠 검증 게이트**를 얹은 최소 구현.

---

## 왜 필요한가

**Threads API는 예약 발행을 지원하지 않는다.** 예약이 필요하면 스케줄러를 직접 만들어야 한다.
그런데 직접 만들면 곧바로 두 가지 문제를 만난다.

1. **중복 발행** — 사용자가 두 번 누르거나 워커가 둘이면 같은 글이 두 번 올라간다
2. **발행이 2단계** — 컨테이너를 만들고 따로 발행해야 한다. 중간에 죽으면 무엇이 올라갔는지 모른다

이 저장소는 그 둘을 푸는 데 집중한다.

## 구조

```
src/
  core/publish.ts        멱등키 · 링크주입 · 실패분류 · 백오프 · 쿼터판정  (외부 I/O 없음)
  content/threads.ts     훅 라이브러리 H1~H10 · 로테이션 · 프롬프트 · 검증 게이트
  content/safety.ts      2단 안전 필터 — 키워드 → AI 적합성 판정
  llm/provider.ts        LLM 백엔드 추상화 + 폴백 (CLI / API)
  queue/job-store.ts     저장소 계약 (두 구현이 공유)
  queue/store.ts         인메모리 큐 — 설정 없이 도는 기본값
  queue/supabase-store.ts  Postgres 큐 — 원자성을 DB 제약이 강제
  queue/contract.test.ts   같은 테스트를 두 구현에 돌린다
  threads/client.ts      Threads Graph API — 2단계 발행, 첫 댓글, 쿼터 조회
  worker/publish-due.ts  워커 — 집기 → 쿼터 → 링크주입 → 발행 → 첫 댓글 → 기록
  demo/e2e.test.ts       한 흐름 관통 (가짜 API, 토큰 없이 전 구간)

supabase/
  migrations/0001_init.sql   테이블 · UNIQUE 제약 · 트랜잭션 함수 · RLS
```

### 멱등성 — 이 저장소의 핵심

```
idempotencyKey = draftId : channel : scheduleBucket(5분 내림)
```

같은 글을 14:01과 14:04에 예약하면 **같은 키**가 나온다. 두 번 올리겠다는 뜻이 아니라
같은 의도의 중복 클릭이기 때문이다.

검사와 변경 사이에 `await`를 두지 않는다. **한 줄이라도 끼면 그 틈으로 중복이 들어온다.**

```ts
// ── 여기부터 await 금지 ────────────────────────────────
const existingId = this.#byKey.get(key);
if (existingId !== undefined) return { job: ..., duplicated: true };
...
this.#byKey.set(key, job.id);
```

> 프로세스가 여럿이면 이 보장은 깨진다. 그래서 **Postgres 구현을 나란히 뒀다** — 거기서는
> `idempotency_key`의 UNIQUE 제약과 조건부 UPDATE의 갱신 행 수가 같은 일을 한다.
> 두 구현은 [같은 계약 테스트](src/queue/contract.test.ts)를 통과해야 한다.

### 검증 게이트 — 규칙을 문서가 아니라 코드에 둔다

글쓰기 규칙을 문서에만 적어 두면 모델이 매번 어긴다. 그래서 코드가 거절한다.

**거절** — 글이 3개가 아님 / 훅·구조 유형 중복 / 직접 판매어·과장(`지금 구매`, `최저가`, `100%`) /
CTA 자리표시자 누락 / 실제 URL 박힘 / 100자 초과 / `cta_kind` 오류

**경고** — 훅에 반올림 숫자(`약 3개월` → `87일`) / 훅에서 답을 줘버림 / 최근 글과 단어 45% 이상 겹침

`char_count`는 모델이 준 값을 믿지 않고 코드가 다시 센다.

### 실패를 어떻게 나누나

```
5xx · 429 · "does not exist"    → 재시도 (지수백오프, 최대 5회 → dead)
글자수 초과 · 빈 본문 · 401/403  → 즉시 접는다 (재시도 횟수를 태우지 않는다)
쿼터 소진                         → 실패가 아니라 deferred (다음 창으로)
```

"글자수 초과"를 다섯 번 다시 보내 봐야 답은 같고 쿼터만 없어진다.

## 확인한 것

```
$ npm test
 ✓ src/core/publish.test.ts     (22 tests)
 ✓ src/llm/provider.test.ts     (18 tests)
 ✓ src/queue/store.test.ts      (14 tests)
 ✓ src/content/threads.test.ts  (24 tests)
 ✓ src/queue/contract.test.ts   (15 tests)   ← 두 구현 공통 계약
 ✓ src/demo/e2e.test.ts         (5 tests)
 Test Files  6 passed (6)
      Tests  97 passed (97)
```

`.env`에 Supabase 접속 정보를 채우면 **같은 계약이 실제 Postgres에도** 돈다.

```
$ npm run test:supabase
 ✓ src/queue/contract.test.ts   (28)  4810ms   ← 인메모리 13 + Postgres 13
 Test Files  6 passed (6)
      Tests  110 passed | 1 skipped (111)
```

25ms → **4810ms**. 190배 느려진 게 서울 리전까지 왕복했다는 증거다.

```
$ npm run demo
  훅 3종 선정: H1 고민 직격형 / H2 숫자 충격형 / H6 손실회피·경고형
  검증 통과 · 경고 0건
  동시 예약 10건 → 잡 1개
  [ok] job_0001 → https://www.threads.net/@demo_account/post/media_container_1
```

| 확인한 것 | 결과 |
|---|---|
| 한 흐름 관통 (글 3종 → 검증 → 예약 → 발행 → permalink) | 사람 개입 0회 |
| **동시 예약 10건** | 잡 1개. 열 건 모두 같은 잡을 가리킴(실패를 안 봄) |
| **동시 5워커 claim** | 1개만 성공, 나머지는 조용히 넘어감 |
| API 호출 순서 | `publishing_limit` → `threads` → `threads_publish` |
| 쿼터 소진 시 | 컨테이너조차 안 만들고 미룸, 재시도 횟수 안 태움 |
| 일시 실패 후 | 다음 실행에서 발행됨 |
| **첫 댓글이 실패해도** | 본문은 성공으로 남음 — 재시도하면 두 번 게시되므로 |
| LLM primary 실패 시 | secondary 로 폴백 |

## Threads API 제약 (공식 문서 대조 완료)

| 항목 | 값 |
|---|---|
| 게시 쿼터 | **250 / 24h 롤링** (답글 1,000 · 삭제 100은 별도 카운터) |
| 발행 구조 | **2단계** — 컨테이너 생성 → 발행. 컨테이너는 24h 미발행 시 만료 |
| 예약 발행 | **API가 지원하지 않음** |
| 장기 토큰 | 60일, 발급 24h 후부터 갱신 가능 |
| 쿼터 조회 | `GET /{threads-user-id}/threads_publishing_limit` |
| 웹훅 | 앱 검수/Advanced Access 필요 → MVP는 폴링 |

### 참고 자료에서 찾은 오류

널리 도는 자료들이 쿼터 조회 엔드포인트를 `content_publishing_limit`으로 적어 두는데,
**그건 Instagram 쪽 이름이다.** Threads는 `threads_publishing_limit`이다.
그대로 구현하면 쿼터 조회가 통째로 실패한다.

그리고 **쿼터를 상수로 박지 않는다.** 계정마다 실효 한도가 다르고 신규 계정은 더 낮게
걸린다는 보고가 있어 매 실행 API에 물어본다. 응답이 이상하면 발행하지 않는다 — **모르면 안 쏜다.**

## 실행

```bash
npm install
npm test          # 97개 (인메모리)
npm run demo      # 한 흐름을 눈으로
npm run typecheck
```

**Postgres에 붙이려면** → [`docs/supabase-setup.md`](docs/supabase-setup.md)
스키마를 적용하고 `.env`를 채운 뒤:

```bash
npm run test:supabase   # 같은 계약 테스트가 실제 DB 에도 돈다
```

실제 계정에 붙이려면 `.env.example`을 `.env`로 복사해 채운다. **`.env`는 커밋되지 않는다.**

## 실제 계정에 올리기

```bash
npm run cli -- connect                  # 토큰 확인 · 쿼터 조회
npm run cli -- generate "<주제>"         # 글 3종 생성 → 검증 → 저장 (안 올라감)
npm run cli -- publish 1 --dry          # 올릴 글 최종 확인 (안 올라감)
npm run cli -- publish 1                # 실제 발행
```

`generate` 와 `publish` 를 나눈 이유 — **`publish` 는 진짜 올라가고 되돌리려면 손으로 지워야 한다.**
그래서 중간에 눈으로 보는 단계를 강제로 넣었고, `--dry` 로 한 번 더 확인할 수 있다.

`generate` 가 하는 일:

1. 훅 3종을 **코드가 골라 프롬프트에 지정**한다 (모델이 고르게 두지 않는다). 최근 쓴 훅은 피한다
2. LLM 호출 — primary 실패 시 secondary 로 폴백
3. **검증 게이트** — 훅·구조 중복, 직접 판매어, 100자 초과, 실제 URL 이면 거절
4. **안전 필터 2단** — 키워드 → AI 적합성 판정. AI 판정이 실패하면 통과시키지 않는다
5. 통과한 것만 `.data/drafts.json` 에 저장

### 실제로 돌려 본 기록 (2026-09-08)

가짜 API 가 아니라 **실계정에 한 편 올린** 기록이다.

```
$ npm run cli -- connect
연결됨 — @ldk1575 (id 2826...)
쿼터 — 0 / 250 사용, 남음 250
→ 발행 가능
```

```
$ npm run cli -- generate "AI한테 코딩 시키는 사람들이 제일 많이 털리는 것"
훅 3종: H1 고민 직격형 / H2 숫자 충격형 / H6 손실회피·경고형

응답: gemini-api — 검증 실패, 고쳐서 다시 요청합니다
  ✗ 1번 글이 100자를 넘는다 (103자)          ← 게이트가 잡음

응답: gemini-api                              ← 재요청 결과 91 / 90 / 99자
검증 통과 · 안전 필터 통과 → .data/drafts.json 에 저장했다
```

```
$ npm run cli -- publish 1
쿼터 남음 250 → 발행합니다...
✓ 올라갔습니다
  media id : ...
  permalink: https://www.threads.net/@ldk1575/post/...
```

**게이트가 잡은 것** — 100자 초과. 사유를 모델에게 돌려주니 사람 개입 없이 고쳐서 다시 왔다.

**게이트가 못 잡은 것** — 모델이 *"내 API 키가 다 털리고 있더라고"* 라고 썼는데
**실제로는 털리지 않았다.** 올라가기 전에 막았다. 다른 글에는 *"2분 만에 털린"* 이라는
근거 없는 수치도 있었다.

거짓 경험담과 지어낸 숫자는 자동으로 판별하기 어렵다. 그래서 **사람이 보는 단계**가
필요하고, `generate` 와 `publish` 를 나눈 것이 실제로 값을 했다.
실제 발행본은 *"올라갈 뻔했더라고 / 박제될 뻔"* 으로 고쳐서 올렸다.

프롬프트에도 규칙을 하나 더 넣었다 — *"모르는 숫자는 지어내지 마라."*
다만 이걸 넣고도 뚫린 적이 있으므로, 프롬프트는 방어의 마지막 줄이 아니다.

### LLM 백엔드

`.env` 두 줄로 정한다. CLI 백엔드는 설치된 구독 CLI 를 비대화형으로 부르므로 API 키가 필요 없다.

```
LLM_PRIMARY=claude-cli      # gemini-cli | codex-cli | claude-cli | claude-api | gemini-api | openai-api
LLM_SECONDARY=gemini-api    # primary 가 죽으면 여기로
```

## 아직 안 한 것

- 채널 토큰 저장 테이블 — 토큰은 앱 레벨 암호화 후 넣어야 한다
- 로그인·권한 — 로컬 전용 전제
- 이미지/영상 발행, 답글 자동응대, 성과 수집

## 문서

- [`docs/실행-치트시트.md`](docs/실행-치트시트.md) — 글 한 편 올리는 명령 전부
- [`docs/supabase-setup.md`](docs/supabase-setup.md) — Postgres 붙이기
- [`docs/회고.md`](docs/회고.md)

## 주의

Threads 자동화는 **공식 API만** 사용한다. 내부 토큰을 긁는 리버스엔지니어링 방식은
계정 정지 위험이 있어 배제했다. 특히 **남의 계정을 대신 운용하는 서비스**라면
그 정지가 운영자 책임이 된다.
