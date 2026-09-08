# Supabase 붙이기

기본값은 **인메모리 저장소**다. 설정 없이 `npm test`가 그대로 돈다.
아래는 실제 Postgres에 붙일 때만 하면 된다.

---

## 1. 스키마 적용

Supabase 대시보드 → **SQL Editor** → [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql)
내용을 붙여넣고 **Run**.

만들어지는 것:

| 대상 | 역할 |
|---|---|
| `publish_jobs` | 예약 큐. `idempotency_key`에 **UNIQUE** |
| `posts` | 발행 결과. `publish_job_id`에 **UNIQUE** |
| `publish_jobs_due_idx` | 워커가 매번 도는 질의(`status`, `scheduled_at`) |
| `mark_publish_success()` | 상태 변경 + 결과 기록을 **한 트랜잭션**으로 |
| RLS | 두 테이블에 활성화 |

같은 SQL을 여러 번 돌려도 안전하다(`if not exists` / `create or replace`).

## 2. 접속 정보

대시보드 → **Project Settings → API** 에서 두 값을 가져와 `.env`에 넣는다.

```bash
cp .env.example .env
```

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_KEY=<service_role 키>
```

> ⚠️ **`service_role` 키는 RLS를 우회한다.** 서버에서만 쓰고, 브라우저로 내려보내지 않는다.
> `.env`는 `.gitignore`에 걸려 있어 커밋되지 않는다.

## 3. 검증

```bash
npm run test:supabase
```

인메모리와 **똑같은 계약 테스트**가 실제 DB에도 돈다. 통과하면 이렇게 나온다.

```
✓ src/queue/contract.test.ts   (28)  4810ms
 Test Files  6 passed (6)
      Tests  110 passed | 1 skipped (111)
```

`contract.test.ts`가 15개에서 **28개**로 늘고, 25ms 에서 **4810ms**로 느려지면 붙은 것이다.
느려진 것이 곧 증거다 — 인메모리라면 그 시간이 안 나온다.

테스트는 자기가 만든 잡만 지우고 끝난다(`afterAll`). 다른 데이터는 건드리지 않는다.

---

## 왜 두 구현을 같은 테스트로 도는가

원자성을 **기대는 방식이 다르기 때문**이다.

| | 인메모리 | Supabase |
|---|---|---|
| 중복 등록 | 검사와 변경 사이에 `await`를 안 끼운다 | `idempotency_key` **UNIQUE 제약** |
| 동시 집기 | 같은 이유로 한 번에 한 줄만 실행됨 | `status='queued'` 조건부 UPDATE의 **갱신 행 수** |
| 결과 기록 | `if (status === 'success') return` | `mark_publish_success()` **트랜잭션** |

인메모리 쪽 보장은 **프로세스가 하나일 때만** 성립한다. 워커를 둘 이상 띄우는 순간 깨진다.
그래서 배포에서는 Supabase 구현을 쓰고, **같은 테스트로 결과가 같은지 확인**한다.

## 코드에서 바꿔 끼우기

두 구현은 `JobStore` 인터페이스를 공유한다. 워커는 어느 쪽인지 모른다.

```ts
import { createClient } from "@supabase/supabase-js";
import { MemoryJobStore } from "./src/queue/store.ts";
import { SupabaseJobStore } from "./src/queue/supabase-store.ts";
import type { JobStore } from "./src/queue/job-store.ts";

const store: JobStore = process.env.SUPABASE_URL
  ? new SupabaseJobStore(
      createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY!, {
        auth: { persistSession: false },
      }),
    )
  : new MemoryJobStore();
```

## 아직 안 한 것

- **`channel_accounts` 테이블** — 채널 토큰 저장. 토큰은 앱 레벨에서 암호화한 뒤 넣어야 한다
- **RLS 정책** — 지금은 활성화만 해 뒀다. service role로만 접근하므로 정책이 없어도 동작한다.
  사용자별 접근을 열려면 그때 정책을 쓴다
- **Supabase Auth** — 로그인은 이 MVP 범위 밖이다
