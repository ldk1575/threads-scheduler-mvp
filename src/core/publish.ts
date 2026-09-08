/**
 * POST 도메인 순수 로직.
 *
 * 이 파일은 외부 I/O 를 하지 않는다 — fetch·DB·파일 접근 금지.
 * 상위 플랫폼 코어 패키지로 그대로 이관되는 부분이며,
 * 상위 플랫폼 코어 패키지의 규칙(외부 I/O 추가 금지)을 미리 지킨다.
 *
 * 여기 담긴 판단은 전부 "발행하기 전에 결정되는 것"이다.
 * 실제 API 호출은 src/threads/client.ts 가 맡는다.
 */

/** Threads 게시글 본문 한도. 초과하면 API 가 400 을 준다. */
export const THREADS_MAX_CHARS = 500;

/** 예약 시각을 묶는 단위. 이 구간 안의 재요청은 같은 발행으로 본다. */
const BUCKET_MINUTES = 5;

/** 재시도 상한. 소진되면 dead 로 보낸다. */
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 60_000;

const CTA_PLACEHOLDER = "{{CTA_링크문구}}";

// ───────────────────────────────────────────────────────────
// 멱등성
// ───────────────────────────────────────────────────────────

/**
 * 예약 시각을 5분 단위로 내려 문자열로 만든다.
 *
 * 왜 내림인가 — 사용자가 14:03 과 14:04 에 같은 글을 두 번 예약해도
 * 그건 "두 번 올리겠다"는 뜻이 아니라 같은 의도의 중복 클릭이다.
 */
export function scheduleBucket(at: Date): string {
  const d = new Date(at.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / BUCKET_MINUTES) * BUCKET_MINUTES);

  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

/**
 * 중복 발행을 막는 키.
 *
 * 주의 — 이 키는 DB 의 unique 제약과 짝이다.
 * 애플리케이션에서 "먼저 조회하고 없으면 삽입"하면 그 사이가 뚫린다.
 * 반드시 삽입을 시도하고 unique 위반을 잡아 기존 행을 반환해야 한다.
 */
export function buildIdempotencyKey(draftId: string, channel: string, scheduledAt: Date): string {
  return `${draftId}:${channel}:${scheduleBucket(scheduledAt)}`;
}

// ───────────────────────────────────────────────────────────
// 추적 링크 주입
// ───────────────────────────────────────────────────────────

export type InjectResult = {
  text: string;
  /** 상한을 맞추려고 본문을 잘랐는지 */
  truncated: boolean;
};

/**
 * 본문에 추적 링크를 넣는다.
 *
 * 모델에게 맡기지 않는 이유 — 링크가 빠지면 클릭 추적이 통째로 끊긴다.
 * 그래서 이 치환은 결정적이어야 하고, 길이를 줄여야 할 때
 * **본문을 자르지 링크를 자르지 않는다.**
 *
 * @throws `E-POST-422` 링크만으로도 상한을 못 맞출 때. 조용히 링크를 버리지 않는다.
 */
export function injectTrackingLink(
  body: string,
  link: string,
  maxChars: number = THREADS_MAX_CHARS,
): InjectResult {
  let withLink: string;

  if (body.includes(CTA_PLACEHOLDER)) {
    withLink = body.replaceAll(CTA_PLACEHOLDER, link);
  } else if (body.includes(link)) {
    withLink = body; // 이미 들어 있다 — 중복해 넣지 않는다
  } else {
    withLink = `${body}\n\n${link}`;
  }

  if (withLink.length <= maxChars) {
    return { text: withLink, truncated: false };
  }

  // 상한 초과 — 링크는 보존하고 본문을 줄인다.
  const idx = withLink.lastIndexOf(link);
  const before = withLink.slice(0, idx);
  const after = withLink.slice(idx + link.length);

  const budget = maxChars - link.length - after.length;
  if (budget < 1) {
    throw new Error(
      `E-POST-422: 상한 ${maxChars}자 안에 링크(${link.length}자)를 넣을 수 없다`,
    );
  }

  const trimmed = before.slice(0, budget).replace(/\s+$/u, "");
  return { text: `${trimmed}${link}${after}`, truncated: true };
}

// ───────────────────────────────────────────────────────────
// 실패 분류
// ───────────────────────────────────────────────────────────

export type FailureKind = "transient" | "permanent";

export type ApiFailure = {
  /** HTTP 상태. 네트워크 오류처럼 응답이 없으면 0 */
  status: number;
  message: string;
};

/**
 * 일시 실패는 재시도하고, 영구 실패는 즉시 접는다.
 *
 * 이 구분이 없으면 "글자수 초과"를 5번 재시도하며 쿼터만 태운다.
 */
export function classifyFailure(err: ApiFailure): FailureKind {
  const msg = err.message.toLowerCase();

  // 응답 없음(네트워크) · 서버 오류 · 레이트리밋
  if (err.status === 0 || err.status >= 500 || err.status === 429) return "transient";

  // 2단계 발행의 경합 — 컨테이너가 아직 준비되지 않았다. 잠시 뒤면 된다.
  if (msg.includes("does not exist") || msg.includes("not found yet")) return "transient";

  // 나머지 4xx 는 사람이 고쳐야 한다 (본문·토큰·권한)
  return "permanent";
}

// ───────────────────────────────────────────────────────────
// 재시도
// ───────────────────────────────────────────────────────────

/**
 * 다음 재시도까지 기다릴 시간. 상한을 넘겼으면 null 이고, 호출자는 dead 로 보낸다.
 */
export function nextRetryDelayMs(retryCount: number): number | null {
  if (retryCount >= MAX_RETRIES) return null;
  return Math.min(RETRY_BASE_MS * 2 ** retryCount, RETRY_CAP_MS);
}

// ───────────────────────────────────────────────────────────
// 쿼터
// ───────────────────────────────────────────────────────────

export type PublishingLimit = {
  quota_usage: number;
  quota_total: number;
};

export type QuotaDecision = {
  action: "publish" | "defer";
  remaining: number;
};

/**
 * 발행 한도를 판정한다.
 *
 * 한도를 상수로 박지 않는 이유 — 계정마다 실효 한도가 다르다.
 * 신규·저활동 계정은 문서값보다 낮게 걸린다는 보고가 있어,
 * 매 실행 `GET /{threads-user-id}/threads_publishing_limit` 을 읽는다.
 *
 * 응답이 이상하면 발행하지 않는다. 모르면 안 쏜다.
 */
export function decideQuota(limit: PublishingLimit | null | undefined): QuotaDecision {
  if (
    !limit ||
    typeof limit.quota_usage !== "number" ||
    typeof limit.quota_total !== "number"
  ) {
    return { action: "defer", remaining: 0 };
  }

  const remaining = Math.max(0, limit.quota_total - limit.quota_usage);
  return { action: remaining > 0 ? "publish" : "defer", remaining };
}
