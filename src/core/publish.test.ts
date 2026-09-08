import { describe, expect, test } from "vitest";
import {
  buildIdempotencyKey,
  scheduleBucket,
  injectTrackingLink,
  classifyFailure,
  nextRetryDelayMs,
  decideQuota,
  THREADS_MAX_CHARS,
} from "./publish.ts";

// ───────────────────────────────────────────────────────────
// 1. 멱등키 — 같은 글·같은 채널·같은 5분 구간이면 같은 키
// ───────────────────────────────────────────────────────────
describe("멱등키", () => {
  test("예약 시각을 5분 단위로 내린다", () => {
    expect(scheduleBucket(new Date("2026-09-08T14:03:59.999Z"))).toBe("2026-09-08T14:00");
    expect(scheduleBucket(new Date("2026-09-08T14:05:00.000Z"))).toBe("2026-09-08T14:05");
    expect(scheduleBucket(new Date("2026-09-08T14:09:59.000Z"))).toBe("2026-09-08T14:05");
  });

  test("같은 5분 구간의 두 요청은 키가 같다 — 중복 발행이 막히는 지점", () => {
    const a = buildIdempotencyKey("draft_1", "threads", new Date("2026-09-08T14:01:00Z"));
    const b = buildIdempotencyKey("draft_1", "threads", new Date("2026-09-08T14:04:30Z"));
    expect(a).toBe(b);
    expect(a).toBe("draft_1:threads:2026-09-08T14:00");
  });

  test("구간이 다르면 키가 다르다", () => {
    const a = buildIdempotencyKey("draft_1", "threads", new Date("2026-09-08T14:04:00Z"));
    const b = buildIdempotencyKey("draft_1", "threads", new Date("2026-09-08T14:06:00Z"));
    expect(a).not.toBe(b);
  });

  test("글이 다르면 키가 다르다", () => {
    const a = buildIdempotencyKey("draft_1", "threads", new Date("2026-09-08T14:00:00Z"));
    const b = buildIdempotencyKey("draft_2", "threads", new Date("2026-09-08T14:00:00Z"));
    expect(a).not.toBe(b);
  });
});

// ───────────────────────────────────────────────────────────
// 2. 추적 링크 주입 — 모델에 맡기지 않고 코드가 결정적으로 처리
// ───────────────────────────────────────────────────────────
describe("추적 링크 주입", () => {
  const LINK = "https://lnk.example/r/abc123";

  test("플레이스홀더를 링크로 치환한다", () => {
    const out = injectTrackingLink("써보고 놀랐어요\n\n{{CTA_링크문구}}", LINK);
    expect(out.text).toBe("써보고 놀랐어요\n\n" + LINK);
    expect(out.truncated).toBe(false);
  });

  test("플레이스홀더가 없으면 본문 끝에 링크를 덧붙인다", () => {
    const out = injectTrackingLink("써보고 놀랐어요", LINK);
    expect(out.text.endsWith(LINK)).toBe(true);
  });

  test("치환 후 상한을 넘으면 본문을 자르고 링크는 보존한다", () => {
    const body = "가".repeat(120) + "\n\n{{CTA_링크문구}}";
    const out = injectTrackingLink(body, LINK, 100);
    expect(out.text.length).toBeLessThanOrEqual(100);
    expect(out.text).toContain(LINK); // 링크는 절대 잘리지 않는다
    expect(out.truncated).toBe(true);
  });

  test("기본 상한은 Threads API 한도(500자)다", () => {
    expect(THREADS_MAX_CHARS).toBe(500);
    const out = injectTrackingLink("가".repeat(600) + "{{CTA_링크문구}}", LINK);
    expect(out.text.length).toBeLessThanOrEqual(500);
    expect(out.text).toContain(LINK);
  });

  test("링크만으로 상한을 못 맞추면 던진다 — 조용히 링크를 버리지 않는다", () => {
    expect(() => injectTrackingLink("본문", LINK, 10)).toThrow(/E-POST-422/);
  });

  test("링크가 이미 본문에 있으면 중복해 넣지 않는다", () => {
    const out = injectTrackingLink(`이미 ${LINK} 있음`, LINK);
    expect(out.text.split(LINK).length - 1).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────
// 3. 실패 분류 — 영구 실패를 재시도해 무한루프에 빠지지 않는다
// ───────────────────────────────────────────────────────────
describe("실패 분류", () => {
  test("5xx·네트워크는 일시 실패", () => {
    expect(classifyFailure({ status: 500, message: "server error" })).toBe("transient");
    expect(classifyFailure({ status: 503, message: "unavailable" })).toBe("transient");
    expect(classifyFailure({ status: 0, message: "fetch failed" })).toBe("transient");
  });

  test("429는 일시 실패 — 쿼터/레이트리밋", () => {
    expect(classifyFailure({ status: 429, message: "rate limited" })).toBe("transient");
  });

  test("컨테이너가 아직 안 만들어진 상태는 일시 실패", () => {
    expect(classifyFailure({ status: 400, message: "Media ID does not exist" })).toBe("transient");
  });

  test("글자수 초과·빈 본문은 영구 실패 — 재시도해도 같다", () => {
    expect(classifyFailure({ status: 400, message: "text exceeds 500 character" })).toBe("permanent");
    expect(classifyFailure({ status: 400, message: "The post is empty" })).toBe("permanent");
  });

  test("401·403은 영구 실패 — 토큰 문제라 사람이 고쳐야 한다", () => {
    expect(classifyFailure({ status: 401, message: "invalid token" })).toBe("permanent");
    expect(classifyFailure({ status: 403, message: "forbidden" })).toBe("permanent");
  });
});

// ───────────────────────────────────────────────────────────
// 4. 재시도 — 지수 백오프, 5회 소진되면 dead
// ───────────────────────────────────────────────────────────
describe("재시도 백오프", () => {
  test("시도할수록 간격이 늘어난다", () => {
    const d0 = nextRetryDelayMs(0);
    const d1 = nextRetryDelayMs(1);
    const d2 = nextRetryDelayMs(2);
    expect(d0).not.toBeNull();
    expect(d0!).toBeGreaterThan(0);
    expect(d1!).toBeGreaterThan(d0!);
    expect(d2!).toBeGreaterThan(d1!);
  });

  test("5회를 넘기면 null — 호출자는 dead 로 보낸다", () => {
    expect(nextRetryDelayMs(4)).not.toBeNull();
    expect(nextRetryDelayMs(5)).toBeNull();
    expect(nextRetryDelayMs(9)).toBeNull();
  });

  test("간격에 상한이 있다 — 무한정 늘어나지 않는다", () => {
    expect(nextRetryDelayMs(4)!).toBeLessThanOrEqual(60_000);
  });
});

// ───────────────────────────────────────────────────────────
// 5. 쿼터 — 하드코딩하지 않고 API 응답으로 판정한다
// ───────────────────────────────────────────────────────────
describe("쿼터 판정", () => {
  test("여유가 있으면 발행한다", () => {
    expect(decideQuota({ quota_usage: 10, quota_total: 250 })).toEqual({
      action: "publish",
      remaining: 240,
    });
  });

  test("소진되면 실패가 아니라 다음 창으로 미룬다", () => {
    expect(decideQuota({ quota_usage: 250, quota_total: 250 })).toEqual({
      action: "defer",
      remaining: 0,
    });
  });

  test("초과 보고돼도 음수 잔량을 만들지 않는다", () => {
    expect(decideQuota({ quota_usage: 260, quota_total: 250 })).toEqual({
      action: "defer",
      remaining: 0,
    });
  });

  test("응답이 이상하면 보수적으로 미룬다 — 모르면 안 쏜다", () => {
    expect(decideQuota(null).action).toBe("defer");
    expect(decideQuota({} as never).action).toBe("defer");
  });
});
