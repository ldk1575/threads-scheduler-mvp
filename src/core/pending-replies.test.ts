import { describe, expect, test } from "vitest";
import {
  addPending,
  elapsedMinutes,
  judgeTiming,
  pickNext,
  removePending,
  MIN_REPLY_DELAY_MIN,
  MAX_REPLY_WINDOW_MIN,
  type PendingReply,
} from "./pending-replies.ts";

function p(over: Partial<PendingReply> = {}): PendingReply {
  return {
    mediaId: "m1",
    topic: "클렌징오일",
    hookType: "H3 상식 반전형",
    text: "첫 댓글 본문",
    publishedAt: "2026-09-11T00:00:00.000Z",
    ...over,
  };
}

describe("대기 목록", () => {
  test("가장 먼저 올라간 글부터 단다", () => {
    const list = [
      p({ mediaId: "늦게", publishedAt: "2026-09-11T02:00:00.000Z" }),
      p({ mediaId: "먼저", publishedAt: "2026-09-11T00:00:00.000Z" }),
    ];
    expect(pickNext(list)?.mediaId).toBe("먼저");
  });

  test("비어 있으면 undefined", () => {
    expect(pickNext([])).toBeUndefined();
  });

  test("같은 글에 대기를 두 번 만들지 않는다 — 두 번 달면 손으로 지워야 한다", () => {
    const once = addPending([], p({ mediaId: "m1", text: "처음" }));
    const twice = addPending(once, p({ mediaId: "m1", text: "나중" }));

    expect(twice).toHaveLength(1);
    expect(twice[0]?.text).toBe("나중");
  });

  test("단 것은 목록에서 빠진다", () => {
    const list = [p({ mediaId: "m1" }), p({ mediaId: "m2" })];
    expect(removePending(list, "m1").map((x) => x.mediaId)).toEqual(["m2"]);
  });
});

describe("시점 판정", () => {
  const now = new Date("2026-09-11T01:00:00.000Z");

  test("경과 분을 센다", () => {
    expect(elapsedMinutes(p({ publishedAt: "2026-09-11T00:30:00.000Z" }), now)).toBe(30);
  });

  test("미래 시각이어도 음수가 안 나온다", () => {
    expect(elapsedMinutes(p({ publishedAt: "2026-09-11T02:00:00.000Z" }), now)).toBe(0);
  });

  test(`${MIN_REPLY_DELAY_MIN}분 미만이면 이르다고 말한다`, () => {
    const r = judgeTiming(3);
    expect(r.verdict).toBe("too-soon");
    expect(r.note).toContain("같이 올라간 것처럼");
  });

  test("적당한 구간은 조용하다", () => {
    expect(judgeTiming(45).verdict).toBe("good");
  });

  test(`${MAX_REPLY_WINDOW_MIN}분을 넘기면 늦다고 말한다`, () => {
    const r = judgeTiming(200);
    expect(r.verdict).toBe("late");
    expect(r.note).toContain("묻힐 수");
  });

  test("경계값 — 20분과 120분은 둘 다 적당하다", () => {
    expect(judgeTiming(MIN_REPLY_DELAY_MIN).verdict).toBe("good");
    expect(judgeTiming(MAX_REPLY_WINDOW_MIN).verdict).toBe("good");
  });
});
