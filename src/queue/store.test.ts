import { beforeEach, describe, expect, test } from "vitest";
import { MemoryJobStore } from "./store.ts";

const AT = new Date("2027-09-08T14:02:00Z");

function makeStore() {
  return new MemoryJobStore();
}

const INPUT = {
  draftId: "draft_1",
  channel: "threads",
  channelAccountId: "acct_1",
  productId: "prod_1",
  linkId: "link_1",
  bodyTemplate: "써보고 놀랐어요\n\n{{CTA_링크문구}}",
  scheduledAt: AT,
};

describe("예약 등록", () => {
  let store: MemoryJobStore;
  beforeEach(() => {
    store = makeStore();
  });

  test("처음 등록하면 queued 로 생긴다", async () => {
    const r = await store.enqueue(INPUT);
    expect(r.duplicated).toBe(false);
    expect(r.job.status).toBe("queued");
    expect(r.job.idempotencyKey).toBe("draft_1:threads:2027-09-08T14:00");
  });

  test("같은 5분 구간에 다시 등록하면 새로 만들지 않고 기존 잡을 준다", async () => {
    const first = await store.enqueue(INPUT);
    const second = await store.enqueue({ ...INPUT, scheduledAt: new Date("2027-09-08T14:04:59Z") });

    expect(second.duplicated).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(store.countJobs()).toBe(1);
  });

  test("★ 동시 10건이 몰려도 잡은 하나만 생긴다", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.enqueue(INPUT)),
    );

    const created = results.filter((r) => !r.duplicated);
    expect(created).toHaveLength(1);
    expect(store.countJobs()).toBe(1);

    // 열 건 모두 같은 잡을 가리킨다 — 사용자는 실패를 보지 않는다
    const ids = new Set(results.map((r) => r.job.id));
    expect(ids.size).toBe(1);
  });

  test("과거 시각은 거절한다", async () => {
    await expect(
      store.enqueue({ ...INPUT, scheduledAt: new Date("2020-01-01T00:00:00Z") }, new Date("2027-09-08T00:00:00Z")),
    ).rejects.toThrow(/E-POST-400/);
  });
});

describe("잡 집기(claim)", () => {
  let store: MemoryJobStore;
  beforeEach(() => {
    store = makeStore();
  });

  test("★ 워커 여럿이 동시에 집어도 한 워커만 성공한다", async () => {
    const { job } = await store.enqueue(INPUT);

    const claims = await Promise.all(
      Array.from({ length: 5 }, () => store.claim(job.id)),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(store.get(job.id)!.status).toBe("publishing");
  });

  test("이미 성공한 잡은 다시 집히지 않는다", async () => {
    const { job } = await store.enqueue(INPUT);
    await store.claim(job.id);
    await store.markSuccess(job.id, { externalPostId: "m_1", permalink: "https://threads.net/p/1", bodyFinal: "본문" });

    expect(await store.claim(job.id)).toBe(false);
  });

  test("예약 시각이 안 되면 due 목록에 안 나온다", async () => {
    await store.enqueue(INPUT);
    expect(store.due(new Date("2027-09-08T13:59:00Z"))).toHaveLength(0);
    expect(store.due(new Date("2027-09-08T14:02:00Z"))).toHaveLength(1);
  });
});

describe("발행 결과 기록", () => {
  let store: MemoryJobStore;
  beforeEach(() => {
    store = makeStore();
  });

  test("성공하면 posts 가 정확히 1개 생긴다", async () => {
    const { job } = await store.enqueue(INPUT);
    await store.claim(job.id);
    await store.markSuccess(job.id, {
      externalPostId: "m_1",
      permalink: "https://threads.net/p/1",
      bodyFinal: "본문 https://lnk.example/r/abc",
    });

    expect(store.get(job.id)!.status).toBe("success");
    expect(store.posts()).toHaveLength(1);
    expect(store.posts()[0]!.externalPostId).toBe("m_1");
  });

  test("같은 잡을 두 번 성공 처리해도 posts 는 1개다", async () => {
    const { job } = await store.enqueue(INPUT);
    await store.claim(job.id);
    const p = { externalPostId: "m_1", permalink: "https://threads.net/p/1", bodyFinal: "본문" };
    await store.markSuccess(job.id, p);
    await store.markSuccess(job.id, p);

    expect(store.posts()).toHaveLength(1);
  });

  test("일시 실패는 재시도 횟수가 오르고 queued 로 돌아간다", async () => {
    const { job } = await store.enqueue(INPUT);
    await store.claim(job.id);
    await store.markFailure(job.id, { status: 500, message: "server error" });

    const after = store.get(job.id)!;
    expect(after.status).toBe("queued");
    expect(after.retryCount).toBe(1);
  });

  test("재시도 5회를 소진하면 dead 로 간다", async () => {
    const { job } = await store.enqueue(INPUT);
    for (let i = 0; i < 6; i++) {
      await store.claim(job.id);
      await store.markFailure(job.id, { status: 500, message: "server error" });
    }
    expect(store.get(job.id)!.status).toBe("dead");
  });

  test("영구 실패는 재시도하지 않고 즉시 failed", async () => {
    const { job } = await store.enqueue(INPUT);
    await store.claim(job.id);
    await store.markFailure(job.id, { status: 400, message: "text exceeds 500 character" });

    const after = store.get(job.id)!;
    expect(after.status).toBe("failed");
    expect(after.retryCount).toBe(0);
  });

  test("쿼터 소진은 실패가 아니라 deferred — 재시도 횟수를 태우지 않는다", async () => {
    const { job } = await store.enqueue(INPUT);
    await store.claim(job.id);
    await store.markDeferred(job.id, "쿼터 소진");

    const after = store.get(job.id)!;
    expect(after.status).toBe("queued");
    expect(after.retryCount).toBe(0);
  });

  test("중단 복구 — publishing 상태로 남은 잡은 사람 확인이 필요한 failed 로 표시한다", async () => {
    const { job } = await store.enqueue(INPUT);
    await store.claim(job.id);

    const recovered = store.recoverStuck();

    expect(recovered).toBe(1);
    const after = store.get(job.id)!;
    expect(after.status).toBe("failed");
    expect(after.lastError).toMatch(/프로필을 확인/);
  });
});
