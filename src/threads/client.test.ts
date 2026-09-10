import { describe, expect, test } from "vitest";
import { ThreadsClient, ThreadsApiError, type FetchLike } from "./client.ts";

function res(status: number, body: string): Response {
  return new Response(body, { status });
}

/** 호출을 세면서 미리 정한 응답을 순서대로 돌려준다. */
function stub(queue: readonly (() => Response | Promise<never>)[]) {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    const next = queue[calls.length - 1];
    if (!next) throw new Error(`예상보다 많이 불렀다 (${calls.length}회)`);
    return next() as Response;
  };
  return { calls, fetchImpl };
}

function client(fetchImpl: FetchLike) {
  return new ThreadsClient({
    userId: "123",
    accessToken: "t",
    fetchImpl,
    sleep: async () => {},
  });
}

const OK_LIMIT = JSON.stringify({
  data: [{ quota_usage: 6, config: { quota_total: 250 } }],
});

describe("읽기 재시도", () => {
  test("503 이면 다시 시도해서 살아난다 — 실제로 겪은 실패다", async () => {
    const { calls, fetchImpl } = stub([
      () => res(503, "Service Unavailable"),
      () => res(200, OK_LIMIT),
    ]);

    const r = await client(fetchImpl).getPublishingLimit();

    expect(r).toEqual({ quota_usage: 6, quota_total: 250 });
    expect(calls).toHaveLength(2);
  });

  test("계속 5xx 면 마지막 오류를 던진다", async () => {
    const { calls, fetchImpl } = stub([
      () => res(500, "boom"),
      () => res(500, "boom"),
      () => res(500, "boom"),
    ]);

    await expect(client(fetchImpl).getPublishingLimit()).rejects.toThrow(ThreadsApiError);
    expect(calls).toHaveLength(3); // 최초 1 + 재시도 2
  });

  test("4xx 는 다시 시도하지 않는다 — 다시 해도 같은 답이다", async () => {
    const { calls, fetchImpl } = stub([
      () => res(400, JSON.stringify({ error: { message: "잘못된 토큰" } })),
    ]);

    await expect(client(fetchImpl).getPublishingLimit()).rejects.toThrow("잘못된 토큰");
    expect(calls).toHaveLength(1);
  });

  test("네트워크가 끊겨도(status 0) 다시 시도한다", async () => {
    const { calls, fetchImpl } = stub([
      () => Promise.reject(new Error("ECONNRESET")),
      () => res(200, OK_LIMIT),
    ]);

    await client(fetchImpl).getPublishingLimit();
    expect(calls).toHaveLength(2);
  });
});

describe("쓰기는 재시도하지 않는다", () => {
  // 요청이 닿았는데 응답만 유실된 경우 재시도하면 글이 두 번 올라간다.
  test("POST 가 503 이어도 한 번만 부른다", async () => {
    const { calls, fetchImpl } = stub([() => res(503, "Service Unavailable")]);

    await expect(client(fetchImpl).publishText("본문")).rejects.toThrow(ThreadsApiError);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

describe("오류 메시지", () => {
  test("JSON 이 아닌 본문도 사유에 남는다 — HTTP 503 만 뜨면 못 찾는다", async () => {
    const { fetchImpl } = stub([
      () => res(503, "Service Unavailable"),
      () => res(503, "Service Unavailable"),
      () => res(503, "Service Unavailable"),
    ]);

    await expect(client(fetchImpl).getPublishingLimit()).rejects.toThrow(
      "HTTP 503 — Service Unavailable",
    );
  });

  test("API 가 준 메시지가 있으면 그걸 쓴다", async () => {
    const { fetchImpl } = stub([
      () => res(500, JSON.stringify({ error: { message: "An unknown error occurred" } })),
      () => res(500, JSON.stringify({ error: { message: "An unknown error occurred" } })),
      () => res(500, JSON.stringify({ error: { message: "An unknown error occurred" } })),
    ]);

    await expect(client(fetchImpl).getPublishingLimit()).rejects.toThrow(
      "An unknown error occurred",
    );
  });
});
