/**
 * 한 흐름 관통 — 상품 → 글 3종 → 검증 → 예약 → 발행 → 기록.
 *
 * 이 파일은 데모이자 회귀 테스트다.
 * 실제 Threads API 대신 가짜 서버를 끼워, 토큰 없이도 전 구간이 돈다.
 * `npx vitest run src/demo --reporter=verbose` 로 흐름을 눈으로 볼 수 있다.
 */

import { describe, expect, test } from "vitest";
import { buildThreadsPrompt, validatePosts, type ThreadsPost } from "../content/threads.ts";
import { MemoryJobStore } from "../queue/store.ts";
import { ThreadsClient } from "../threads/client.ts";
import { processDueJobs } from "../worker/publish-due.ts";

const PRODUCT = {
  title: "수분 진정 크림 50ml",
  salePrice: 19_900,
  listPrice: 29_000,
  sellingPoints: ["당김 없이 12시간", "무향·무색소", "임상 테스트 완료"],
  targetCustomer: "오후만 되면 피부가 당기는 30대 직장인",
  tone: "친구에게 카톡하듯",
  experience: "3개월 써본 실사용자",
};

const LINK = "https://lnk.example/r/a1b2c3";
const SCHEDULED = new Date("2027-09-08T14:02:00Z");

/**
 * 가짜 Threads 서버.
 * 2단계 발행을 실제처럼 흉내낸다 — 컨테이너를 먼저 만들지 않고 발행하면 거절한다.
 */
function makeFakeApi(opts: { quotaUsage?: number; failPublishTimes?: number } = {}) {
  const containers = new Set<string>();
  let seq = 0;
  let failsLeft = opts.failPublishTimes ?? 0;
  const calls: string[] = [];

  const fetchImpl = async (url: string): Promise<Response> => {
    const path = url.split("?")[0] ?? "";
    const qs = new URLSearchParams(url.split("?").slice(1).join("?"));
    calls.push(path.replace("https://graph.threads.net/v1.0", ""));

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });

    if (path.endsWith("/threads_publishing_limit")) {
      return json({
        data: [{ quota_usage: opts.quotaUsage ?? 3, config: { quota_total: 250 } }],
      });
    }

    if (path.endsWith("/threads")) {
      if (!qs.get("text")) return json({ error: { message: "The post is empty" } }, 400);
      const id = `container_${++seq}`;
      containers.add(id);
      return json({ id });
    }

    if (path.endsWith("/threads_publish")) {
      const cid = qs.get("creation_id") ?? "";
      if (!containers.has(cid)) {
        return json({ error: { message: "Media ID does not exist" } }, 400);
      }
      if (failsLeft > 0) {
        failsLeft -= 1;
        return json({ error: { message: "internal server error" } }, 500);
      }
      return json({ id: `media_${cid}` });
    }

    // permalink 조회
    return json({ permalink: `https://www.threads.net/@demo_account/post/${path.split("/").pop()}` });
  };

  return { fetchImpl, calls };
}

function makeClient(fetchImpl: (u: string) => Promise<Response>) {
  return new ThreadsClient({
    userId: "17841400000000000",
    accessToken: "FAKE_TOKEN_NOT_A_REAL_SECRET",
    fetchImpl,
    sleep: async () => {}, // 테스트에서는 2단계 사이 지연을 건너뛴다
  });
}

/** LLM 자리. 실제로는 Claude 가 채우지만, 여기서는 규칙을 지킨 스텁을 쓴다. */
function stubLlmResponse(): ThreadsPost[] {
  return [
    {
      hook_type: "H1(고민 직격형)",
      structure: "고백경험담형",
      text:
        "오후 3시만 되면 얼굴이 땅기는 거 나만 그런 줄 알았어요\n\n" +
        "크림을 더 두껍게 바르는 게 답이 아니더라고요.\n" +
        "묵직한 제형으로 바꿔도 그때뿐이고 회의 들어가면 또 똑같았습니다.\n" +
        "바꾼 건 순서였어요. 씻고 물기 남았을 때 얇게 한 겹 올리고 그 위를 덮었더니\n" +
        "저녁까지 버티더라고요. 양을 늘린 게 아니라 타이밍을 옮긴 겁니다.\n" +
        "통을 바꾸기 전에 이것부터 해보셔도 늦지 않습니다.\n" +
        "저는 이 순서로 두 달째인데 아직 같은 통을 씁니다.\n\n{{CTA_링크문구}}",
      char_count: 0,
      cta_kind: "프로필클릭",
      first_comment:
        "덧붙이면, 저는 겨울에만 이 순서로 갑니다.\n" +
        "여름엔 답답해서 오히려 한 겹으로 끝내요.\n" +
        "계절 무시하고 똑같이 하다가 트러블 난 적 있어서 그 뒤로 나눠서 씁니다.",
    },
    {
      hook_type: "H2(숫자 충격형)",
      structure: "리스트형",
      text:
        "수분크림 고를 때 딱 3가지만 봐요\n\n" +
        "1. 바르고 12시간 뒤에도 남아 있는지 — 직후 촉촉함은 아무거나 다 됩니다\n" +
        "2. 끈적임 — 손등에 올리고 종이 한 장 붙여 봅니다. 붙으면 화장이 밀려요\n" +
        "3. 향 — 세지 않은 쪽으로. 오래 쓰면 향이 먼저 질립니다\n\n" +
        "이 셋만 봐도 실패를 반은 줄였어요.\n" +
        "성분표부터 뒤지다가 지쳐서 아무거나 집던 시절이 있었는데, 지금은 이 순서로만 봅니다.\n" +
        "매장에서 3분이면 다 확인돼요.\n\n{{CTA_링크문구}}",
      char_count: 0,
      cta_kind: "저장유도",
      first_comment:
        "종이 붙이는 건 매장에서 직원분이 알려준 방법입니다.\n" +
        "샘플 받아서 손등에 놓고 5분 뒤에 해보면 차이가 확 나요.\n" +
        "저는 이거 하고 나서 반품한 게 두 통입니다.",
    },
    {
      hook_type: "H6(손실회피형)",
      structure: "반전형",
      text:
        "겉에 덧바를수록 속은 더 마릅니다만\n\n" +
        "덮기만 하고 채우는 걸 안 하면 그렇게 됩니다.\n" +
        "저도 한동안 양으로 밀어붙였어요. 아침에 듬뿍, 점심에 또 한 번.\n" +
        "그런데 겉만 번들거리고 볼 안쪽은 여전히 거칠었습니다.\n" +
        "순서를 뒤집고 나서야 그게 덮는 문제가 아니라 채우는 문제였다는 걸 알았어요.\n" +
        "그 뒤로는 아침에 한 번만 바릅니다. 점심에 덧바르던 습관이 없어졌어요.\n" +
        "쓰는 양은 줄었는데 상태는 더 낫습니다.\n\n{{CTA_링크문구}}",
      char_count: 0,
      cta_kind: "댓글유도",
      first_comment:
        "제일 헷갈렸던 게 번들거림이랑 촉촉함을 같은 걸로 본 거였어요.\n" +
        "번들거리는데 당기는 상태가 실제로 있습니다.\n" +
        "거울 말고 볼 안쪽을 손으로 만져 보면 바로 구분됩니다.",
    },
  ];
}

describe("한 흐름 관통", () => {
  test("상품 → 글 3종 → 검증 → 예약 → 발행 → permalink 기록", async () => {
    const log: string[] = [];

    // ── 1. 프롬프트 조립 (훅 로테이션 적용) ──────────────
    const prompt = buildThreadsPrompt(PRODUCT, { recentHooks: ["H4", "H9"] });
    expect(prompt.hooks).toHaveLength(3);
    expect(prompt.hooks.map((h) => h.id)).not.toContain("H4"); // 최근 사용분 회피
    log.push(`훅 3종 선정: ${prompt.hooks.map((h) => `${h.id} ${h.name}`).join(" / ")}`);

    // ── 2. 생성 결과 검증 게이트 ────────────────────────
    const gate = validatePosts(stubLlmResponse());
    expect(gate.errors).toEqual([]);
    expect(gate.ok).toBe(true);
    log.push(`검증 통과 · 경고 ${gate.warnings.length}건`);

    // ── 3. 하나를 골라 예약 (동시 10건이 몰려도 1건) ────
    const store = new MemoryJobStore();
    const chosen = gate.posts[0]!;
    const enqueueInput = {
      draftId: "draft_threads_1",
      channel: "threads",
      channelAccountId: "acct_demo",
      productId: "prod_cream",
      linkId: "link_a1b2c3",
      bodyTemplate: chosen.text,
      scheduledAt: SCHEDULED,
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.enqueue(enqueueInput)),
    );
    expect(results.filter((r) => !r.duplicated)).toHaveLength(1);
    expect(store.countJobs()).toBe(1);
    log.push(`동시 예약 10건 → 잡 ${store.countJobs()}개`);

    // ── 4. 워커가 발행 ──────────────────────────────────
    const { fetchImpl, calls } = makeFakeApi();
    const client = makeClient(fetchImpl);

    const r = await processDueJobs(
      { store, clientFor: () => client, resolveLink: () => LINK, log: (l) => log.push(l) },
      SCHEDULED,
    );

    expect(r).toEqual({ claimed: 1, published: 1, deferred: 0, failed: 0 });

    // 2단계 발행이 순서대로 일어났는지 — 쿼터 먼저, 그다음 컨테이너, 그다음 발행
    expect(calls[0]).toMatch(/threads_publishing_limit$/);
    expect(calls[1]).toMatch(/\/threads$/);
    expect(calls[2]).toMatch(/threads_publish$/);

    // ── 5. 결과 기록 ────────────────────────────────────
    const posts = store.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.permalink).toContain("threads.net");
    expect(posts[0]!.bodyFinal).toContain(LINK); // 링크가 실제로 들어갔다
    expect(posts[0]!.bodyFinal).not.toContain("{{CTA_링크문구}}"); // 자리표시자는 사라졌다
    expect(posts[0]!.bodyFinal.length).toBeLessThanOrEqual(500);

    log.push(`발행 완료 → ${posts[0]!.permalink}`);
    console.log("\n" + log.map((l) => "  " + l).join("\n") + "\n");
  });

  test("쿼터가 소진되면 발행하지 않고 미룬다", async () => {
    const store = new MemoryJobStore();
    await store.enqueue({
      draftId: "d1", channel: "threads", channelAccountId: "a", productId: "p",
      bodyTemplate: "훅\n\n{{CTA_링크문구}}", scheduledAt: SCHEDULED,
    });

    const { fetchImpl, calls } = makeFakeApi({ quotaUsage: 250 });
    const r = await processDueJobs(
      { store, clientFor: () => makeClient(fetchImpl), resolveLink: () => LINK },
      SCHEDULED,
    );

    expect(r).toEqual({ claimed: 1, published: 0, deferred: 1, failed: 0 });
    expect(calls.some((c) => c.endsWith("/threads"))).toBe(false); // 컨테이너조차 안 만든다
    expect(store.get("job_0001")!.retryCount).toBe(0); // 재시도 횟수를 태우지 않는다
  });

  test("일시 실패는 재시도로 돌아가고, 다음 실행에서 발행된다", async () => {
    const store = new MemoryJobStore();
    await store.enqueue({
      draftId: "d1", channel: "threads", channelAccountId: "a", productId: "p",
      bodyTemplate: "훅\n\n{{CTA_링크문구}}", scheduledAt: SCHEDULED,
    });

    const { fetchImpl } = makeFakeApi({ failPublishTimes: 1 });
    const client = makeClient(fetchImpl);
    const deps = { store, clientFor: () => client, resolveLink: () => LINK };

    const first = await processDueJobs(deps, SCHEDULED);
    expect(first.failed).toBe(1);
    expect(store.get("job_0001")!.status).toBe("queued");
    expect(store.get("job_0001")!.retryCount).toBe(1);

    const second = await processDueJobs(deps, SCHEDULED);
    expect(second.published).toBe(1);
    expect(store.posts()).toHaveLength(1);
  });
});

describe("본문=후킹 / 첫 댓글=본론", () => {
  test("링크가 본문이 아니라 첫 댓글에 들어간다", async () => {
    const store = new MemoryJobStore();
    await store.enqueue({
      draftId: "d_hook", channel: "threads", channelAccountId: "a", productId: "p",
      bodyTemplate: "오후 3시만 되면 얼굴 땅기는 거 나만 그래요?",
      replyTemplate: "크림을 두껍게 바르는 게 아니라 잡아두는 게 핵심이더라고요\n\n{{CTA_링크문구}}",
      scheduledAt: SCHEDULED,
    });

    const { fetchImpl, calls } = makeFakeApi();
    const r = await processDueJobs(
      { store, clientFor: () => makeClient(fetchImpl), resolveLink: () => LINK },
      SCHEDULED,
    );

    expect(r.published).toBe(1);
    const post = store.posts()[0]!;

    // 본문에는 링크가 없다 — 후킹만 남는다
    expect(post.bodyFinal).not.toContain(LINK);
    expect(post.bodyFinal).toBe("오후 3시만 되면 얼굴 땅기는 거 나만 그래요?");

    // 링크는 첫 댓글에 들어갔다
    expect(post.replyFinal).toContain(LINK);
    expect(post.replyExternalId).toBeTruthy();

    // 컨테이너 생성이 두 번(본문·답글), 발행도 두 번
    expect(calls.filter((c) => c.endsWith("/threads"))).toHaveLength(2);
    expect(calls.filter((c) => c.endsWith("/threads_publish"))).toHaveLength(2);
  });

  test("★ 첫 댓글이 실패해도 본문은 성공으로 남는다 — 재시도하면 본문이 두 번 올라간다", async () => {
    const store = new MemoryJobStore();
    await store.enqueue({
      draftId: "d_hook2", channel: "threads", channelAccountId: "a", productId: "p",
      bodyTemplate: "후킹 문장",
      replyTemplate: "본론\n\n{{CTA_링크문구}}",
      scheduledAt: SCHEDULED,
    });

    // 두 번째 발행(=첫 댓글)에서만 터지는 가짜 서버
    let publishCount = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      const path = url.split("?")[0] ?? "";
      const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
      if (path.endsWith("/threads_publishing_limit"))
        return json({ data: [{ quota_usage: 1, config: { quota_total: 250 } }] });
      if (path.endsWith("/threads_publish")) {
        publishCount += 1;
        if (publishCount === 2) return json({ error: { message: "internal error" } }, 500);
        return json({ id: "media_body" });
      }
      if (path.endsWith("/threads")) return json({ id: `c_${publishCount}` });
      return json({ permalink: "https://www.threads.net/@demo_account/post/media_body" });
    };

    const log: string[] = [];
    const r = await processDueJobs(
      { store, clientFor: () => makeClient(fetchImpl), resolveLink: () => LINK, log: (l) => log.push(l) },
      SCHEDULED,
    );

    expect(r.published).toBe(1);
    expect(r.failed).toBe(0);
    expect(store.get("job_0001")!.status).toBe("success");
    expect(store.posts()).toHaveLength(1);
    expect(store.posts()[0]!.replyExternalId).toBeUndefined();
    expect(log.join()).toMatch(/첫 댓글 실패/);
  });
});
