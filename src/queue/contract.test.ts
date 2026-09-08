/**
 * 저장소 계약 테스트.
 *
 * 같은 테스트를 두 구현에 돌린다.
 *   MemoryJobStore   — 항상 실행
 *   SupabaseJobStore — SUPABASE_URL / SUPABASE_SERVICE_KEY 가 있을 때만
 *
 * 왜 이렇게 하나 — "로컬에서 됐는데 배포하면 다르다"를 막기 위해서다.
 * 인메모리는 await 를 안 끼운다는 규율에 기대고, Supabase 는 DB 제약에 기댄다.
 * 기대는 방식이 다르니 **같은 결과가 나오는지는 확인해야** 한다.
 *
 * 실행:
 *   npm test                     인메모리만
 *   npm run test:supabase        .env 를 읽어 둘 다
 */

import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { MemoryJobStore } from "./store.ts";
import { SupabaseJobStore } from "./supabase-store.ts";
import type { EnqueueInput, JobStore } from "./job-store.ts";

const SUPABASE_URL = process.env["SUPABASE_URL"];
const SUPABASE_KEY = process.env["SUPABASE_SERVICE_KEY"];
const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);

/** 실행마다 다른 draftId 를 써서 이전 실행과 키가 안 겹치게 한다 */
function uniq(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

const FUTURE = new Date("2027-09-08T14:02:00Z");

function input(draftId: string, over: Partial<EnqueueInput> = {}): EnqueueInput {
  return {
    draftId,
    channel: "threads",
    channelAccountId: "acct_demo",
    productId: "prod_demo",
    linkId: "link_demo",
    bodyTemplate: "훅 문장\n\n{{CTA_링크문구}}",
    scheduledAt: FUTURE,
    ...over,
  };
}

type Factory = { name: string; make: () => JobStore; cleanup?: () => Promise<void> };

const factories: Factory[] = [
  { name: "MemoryJobStore", make: () => new MemoryJobStore() },
];

if (hasSupabase) {
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { persistSession: false },
  });
  const created: string[] = [];
  factories.push({
    name: "SupabaseJobStore",
    make: () => {
      const store = new SupabaseJobStore(db);
      // 테스트가 만든 잡만 지우려고 id 를 모아 둔다
      const orig = store.enqueue.bind(store);
      store.enqueue = async (i, n) => {
        const r = await orig(i, n);
        if (!created.includes(r.job.id)) created.push(r.job.id);
        return r;
      };
      return store;
    },
    cleanup: async () => {
      if (created.length === 0) return;
      await db.from("publish_jobs").delete().in("id", created);
    },
  });
}

afterAll(async () => {
  for (const f of factories) await f.cleanup?.();
});

describe.each(factories)("$name — 저장소 계약", ({ make }) => {
  let store: JobStore;
  let id: string;

  beforeEach(() => {
    store = make();
    id = uniq();
  });

  test("처음 등록하면 queued 로 생긴다", async () => {
    const r = await store.enqueue(input(id));
    expect(r.duplicated).toBe(false);
    expect(r.job.status).toBe("queued");
    expect(r.job.idempotencyKey).toBe(`${id}:threads:2027-09-08T14:00`);
  });

  test("같은 5분 구간에 다시 등록하면 기존 잡을 준다", async () => {
    const first = await store.enqueue(input(id));
    const second = await store.enqueue(
      input(id, { scheduledAt: new Date("2027-09-08T14:04:59Z") }),
    );
    expect(second.duplicated).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });

  test("★ 동시 10건이 몰려도 잡은 하나만 생긴다", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.enqueue(input(id))),
    );
    expect(results.filter((r) => !r.duplicated)).toHaveLength(1);
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
  });

  test("과거 시각은 거절한다", async () => {
    await expect(
      store.enqueue(input(id, { scheduledAt: new Date("2020-01-01T00:00:00Z") })),
    ).rejects.toThrow(/E-POST-400/);
  });

  test("★ 워커 여럿이 동시에 집어도 한 워커만 성공한다", async () => {
    const { job } = await store.enqueue(input(id));
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => store.claim(job.id)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await store.get(job.id))!.status).toBe("publishing");
  });

  test("이미 성공한 잡은 다시 집히지 않는다", async () => {
    const { job } = await store.enqueue(input(id));
    await store.claim(job.id);
    await store.markSuccess(job.id, { externalPostId: "m1", bodyFinal: "본문" });
    expect(await store.claim(job.id)).toBe(false);
  });

  test("★ 같은 잡을 두 번 성공 처리해도 결과 기록은 하나다", async () => {
    const { job } = await store.enqueue(input(id));
    await store.claim(job.id);
    const p = { externalPostId: "m1", permalink: "https://x/1", bodyFinal: "본문" };
    await store.markSuccess(job.id, p);
    await store.markSuccess(job.id, p);

    const mine = (await store.posts()).filter((x) => x.publishJobId === job.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.externalPostId).toBe("m1");
    expect((await store.get(job.id))!.status).toBe("success");
  });

  test("일시 실패는 재시도 횟수가 오르고 queued 로 돌아간다", async () => {
    const { job } = await store.enqueue(input(id));
    await store.claim(job.id);
    await store.markFailure(job.id, { status: 500, message: "server error" });

    const after = (await store.get(job.id))!;
    expect(after.status).toBe("queued");
    expect(after.retryCount).toBe(1);
  });

  test("재시도 5회를 소진하면 dead 로 간다", async () => {
    const { job } = await store.enqueue(input(id));
    for (let i = 0; i < 6; i++) {
      await store.claim(job.id);
      await store.markFailure(job.id, { status: 500, message: "server error" });
    }
    expect((await store.get(job.id))!.status).toBe("dead");
  });

  test("영구 실패는 재시도하지 않고 즉시 failed", async () => {
    const { job } = await store.enqueue(input(id));
    await store.claim(job.id);
    await store.markFailure(job.id, { status: 400, message: "text exceeds 500 character" });

    const after = (await store.get(job.id))!;
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(0);
  });

  test("쿼터 소진은 실패가 아니라 deferred — 재시도 횟수를 안 태운다", async () => {
    const { job } = await store.enqueue(input(id));
    await store.claim(job.id);
    await store.markDeferred(job.id, "쿼터 소진");

    const after = (await store.get(job.id))!;
    expect(after.status).toBe("queued");
    expect(after.retryCount).toBe(0);
  });

  test("예약 시각이 안 되면 due 에 안 나온다", async () => {
    const { job } = await store.enqueue(input(id));
    const before = await store.due(new Date("2027-09-08T13:59:00Z"));
    const after = await store.due(new Date("2027-09-08T14:02:00Z"));
    expect(before.some((j) => j.id === job.id)).toBe(false);
    expect(after.some((j) => j.id === job.id)).toBe(true);
  });

  test("중단 복구 — publishing 은 사람 확인이 필요한 failed 로 표시된다", async () => {
    const { job } = await store.enqueue(input(id));
    await store.claim(job.id);
    await store.recoverStuck();

    const after = (await store.get(job.id))!;
    expect(after.status).toBe("failed");
    expect(after.lastError).toMatch(/프로필을 확인/);
  });
});

describe("Supabase 연결", () => {
  test.skipIf(hasSupabase)("환경변수가 없어 건너뜀 — 인메모리만 검증됨", () => {
    expect(hasSupabase).toBe(false);
  });

  test.runIf(hasSupabase)("실제 DB 에 붙어 계약을 통과했다", () => {
    expect(hasSupabase).toBe(true);
  });
});
