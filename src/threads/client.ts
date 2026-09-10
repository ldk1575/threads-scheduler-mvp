/**
 * Threads Graph API 클라이언트.
 *
 * 공식 API 만 쓴다. 비공식 리버스엔지니어링 라이브러리는
 * `docs/research/oss-candidates.md` §2 에서 이미 배제했다 —
 * 우리는 남의 채널을 대신 운용하므로 계정이 정지되면 우리 책임이 된다.
 *
 * fetch 를 주입받는다. 테스트와 데모에서 가짜를 끼우기 위해서다.
 */

export const THREADS_API_BASE = "https://graph.threads.net/v1.0";

/** 컨테이너 생성과 발행 사이에 두는 지연.
 *  두 호출이 붙으면 "Media ID does not exist" 가 흔하게 난다. */
export const CREATE_PUBLISH_DELAY_MS = 1_200;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ThreadsClientOptions = {
  userId: string;
  accessToken: string;
  fetchImpl?: FetchLike;
  /** 지연을 테스트에서 0 으로 만들기 위해 주입 가능 */
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
};

export class ThreadsApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ThreadsApiError";
    this.status = status;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 읽기 호출만 재시도한다.
 *
 * Threads API 는 5xx 를 간헐적으로 뱉는다. 실제로 쿼터 조회가 503 을 내서
 * 발행 명령이 통째로 죽었다 — 같은 URL 이 잠시 뒤엔 10/10 으로 성공했다.
 *
 * ⚠️ **쓰기(POST)는 재시도하지 않는다.** 요청은 닿았는데 응답만 유실된 경우
 * 재시도하면 글이 두 번 올라간다. 되돌리려면 사람이 손으로 지워야 한다.
 * 못 올리는 쪽이 두 번 올리는 쪽보다 싸다.
 */
const GET_RETRIES = 2;
const RETRY_DELAYS_MS = [500, 1_500];

/** 잠깐 뒤에 다시 하면 될 실패인가. core/publish.ts 의 분류와 같은 규칙이다. */
function isTransient(status: number): boolean {
  return status === 0 || status >= 500 || status === 429;
}

export class ThreadsClient {
  #userId: string;
  #token: string;
  #fetch: FetchLike;
  #sleep: (ms: number) => Promise<void>;
  #base: string;

  constructor(opts: ThreadsClientOptions) {
    this.#userId = opts.userId;
    this.#token = opts.accessToken;
    this.#fetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#base = opts.baseUrl ?? THREADS_API_BASE;
  }

  async #call(path: string, init?: RequestInit): Promise<unknown> {
    // method 가 없으면 GET 이다. 읽기만 다시 시도한다.
    const isRead = (init?.method ?? "GET").toUpperCase() === "GET";
    const attempts = isRead ? GET_RETRIES + 1 : 1;

    let last: ThreadsApiError | undefined;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await this.#callOnce(path, init);
      } catch (e) {
        if (!(e instanceof ThreadsApiError) || !isTransient(e.status)) throw e;
        last = e;
        const wait = RETRY_DELAYS_MS[i];
        if (i < attempts - 1 && wait !== undefined) await this.#sleep(wait);
      }
    }
    throw last;
  }

  async #callOnce(path: string, init?: RequestInit): Promise<unknown> {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.#base}${path}${sep}access_token=${encodeURIComponent(this.#token)}`;

    let res: Response;
    try {
      res = await this.#fetch(url, init);
    } catch (e) {
      // 네트워크 오류는 status 0 — 일시 실패로 분류돼 재시도된다
      throw new ThreadsApiError(0, e instanceof Error ? e.message : "fetch failed");
    }

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    if (!res.ok) {
      // 본문이 JSON 이 아닐 때가 있다. 503 은 그냥 "Service Unavailable" 텍스트로 온다.
      // 상태 코드만 뱉으면 무슨 일인지 못 찾으니 본문 앞부분을 붙인다.
      const apiMsg = (body as { error?: { message?: string } })?.error?.message;
      const snippet = text.trim().slice(0, 120);
      const msg = apiMsg ?? (snippet ? `HTTP ${res.status} — ${snippet}` : `HTTP ${res.status}`);
      throw new ThreadsApiError(res.status, msg);
    }
    return body;
  }

  /**
   * 숫자 사용자 ID 를 얻는다.
   *
   * API 경로에는 **숫자 ID** 만 들어간다. `me` 나 사용자명(`@handle`)을 넣으면
   * `Object with ID '...' does not exist` 로 거절된다 — 흔히 밟는 함정이라
   * 코드가 알아서 풀어 준다. 한 번 풀면 캐시한다.
   */
  async #resolveUserId(): Promise<string> {
    if (/^\d+$/.test(this.#userId)) return this.#userId;
    this.#userId = (await this.me()).id;
    return this.#userId;
  }

  /** 토큰이 살아 있는지 확인하고 username 을 얻는다. */
  async me(): Promise<{ id: string; username?: string }> {
    const r = (await this.#call(`/me?fields=id,username`)) as {
      id: string;
      username?: string;
    };
    return r;
  }

  /**
   * 남은 발행 쿼터.
   *
   * ⚠️ 엔드포인트 이름 주의 — `threads_publishing_limit` 이다.
   * `content_publishing_limit` 은 Instagram 쪽 이름이고, 참고한 외부 자료가
   * 이 둘을 섞어 놨다. 그대로 썼으면 조회가 통째로 실패했다.
   */
  async getPublishingLimit(): Promise<{ quota_usage: number; quota_total: number } | null> {
    const uid = await this.#resolveUserId();
    const r = (await this.#call(
      `/${uid}/threads_publishing_limit?fields=quota_usage,config`,
    )) as {
      data?: Array<{
        quota_usage?: number;
        quota_total?: number;
        config?: { quota_total?: number };
      }>;
    };

    const row = r?.data?.[0];
    if (!row) return null;

    // 응답 모양이 문서마다 갈려 두 자리를 모두 본다. 못 읽으면 null → 호출자가 defer 한다.
    const total = row.config?.quota_total ?? row.quota_total;
    const usage = row.quota_usage;
    if (typeof total !== "number" || typeof usage !== "number") return null;

    return { quota_usage: usage, quota_total: total };
  }

  /**
   * 텍스트 게시글을 올린다. 컨테이너 생성 → 지연 → 발행의 2단계다.
   *
   * 한 잡 안에서 끝까지 간다. 나눠 두면 컨테이너가 24시간 뒤 EXPIRED 되고,
   * 그 사이에 무엇이 올라갔는지 알 수 없게 된다.
   */
  async publishText(text: string): Promise<{ mediaId: string; permalink?: string }> {
    const uid = await this.#resolveUserId();
    const created = (await this.#call(
      `/${uid}/threads?media_type=TEXT&text=${encodeURIComponent(text)}`,
      { method: "POST" },
    )) as { id?: string };

    if (!created?.id) {
      throw new ThreadsApiError(502, "컨테이너 생성 응답에 id 가 없다");
    }

    await this.#sleep(CREATE_PUBLISH_DELAY_MS);

    const published = (await this.#call(
      `/${uid}/threads_publish?creation_id=${encodeURIComponent(created.id)}`,
      { method: "POST" },
    )) as { id?: string };

    if (!published?.id) {
      throw new ThreadsApiError(502, "발행 응답에 id 가 없다");
    }

    let permalink: string | undefined;
    try {
      const meta = (await this.#call(`/${published.id}?fields=permalink`)) as {
        permalink?: string;
      };
      permalink = meta?.permalink;
    } catch {
      // permalink 조회 실패는 발행 실패가 아니다. 이미 올라갔다.
    }

    return { mediaId: published.id, permalink };
  }

  /**
   * 내 게시물에 답글을 단다.
   *
   * 스레드 실전 패턴 — **본문에는 후킹 멘트만 넣고, 진짜 내용과 링크는 첫 댓글에 둔다.**
   * 본문이 짧을수록 끝까지 읽히고, 링크가 본문에 없으면 도달이 덜 눌린다.
   *
   * ⚠️ 이건 **내 글에 내가 다는 첫 댓글**이다.
   * 남의 글에 자동으로 다는 답글(능동댓글)에 링크를 넣는 것은 제재 트리거이며,
   * 그건 절대원칙 4에 따라 Phase 2·기본 비활성이다. 둘을 섞지 마라.
   */
  async replyTo(
    parentMediaId: string,
    text: string,
  ): Promise<{ mediaId: string; permalink?: string }> {
    const uid = await this.#resolveUserId();
    const created = (await this.#call(
      `/${uid}/threads?media_type=TEXT&reply_to_id=${encodeURIComponent(parentMediaId)}&text=${encodeURIComponent(text)}`,
      { method: "POST" },
    )) as { id?: string };

    if (!created?.id) {
      throw new ThreadsApiError(502, "답글 컨테이너 생성 응답에 id 가 없다");
    }

    // 답글은 본문보다 지연을 길게 준다 — 실측 관행 2500ms
    await this.#sleep(CREATE_PUBLISH_DELAY_MS * 2);

    const published = (await this.#call(
      `/${uid}/threads_publish?creation_id=${encodeURIComponent(created.id)}`,
      { method: "POST" },
    )) as { id?: string };

    if (!published?.id) {
      throw new ThreadsApiError(502, "답글 발행 응답에 id 가 없다");
    }
    return { mediaId: published.id };
  }
}
