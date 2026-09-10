/**
 * 첫 댓글을 나중에 단다.
 *
 * 본문과 첫 댓글이 같은 분에 나가면 사람이 쓴 것으로 안 읽힌다. 실제로 올려
 * 보니 둘 다 "1분"으로 찍혔고, 그게 봇 티의 전부였다.
 *
 * 그래서 발행은 본문까지만 하고, 첫 댓글은 여기 대기로 남긴다. 사람이
 * `reply` 로 나중에 단다. 지연을 프로세스가 들고 기다리지 않는 이유는
 * 단순하다 — CLI 는 2시간을 살아 있을 수 없다. 노트북을 닫으면 끝난다.
 *
 * 큐 워커가 생기면 이 자료구조 그대로 예약 잡으로 옮기면 된다.
 */

/** 이 정도는 지나야 사람이 나중에 덧붙인 것처럼 읽힌다. */
export const MIN_REPLY_DELAY_MIN = 20;
/** 이 창을 넘기면 본문이 이미 내려가 첫 댓글이 묻힌다. */
export const MAX_REPLY_WINDOW_MIN = 120;

export type PendingReply = {
  /** 본문 글의 media id. 답글은 여기에 달린다. */
  mediaId: string;
  permalink?: string;
  topic: string;
  hookType: string;
  /** 달아야 할 첫 댓글 본문 */
  text: string;
  /** 본문이 올라간 시각 (ISO) */
  publishedAt: string;
};

export function addPending(
  list: readonly PendingReply[],
  item: PendingReply,
): PendingReply[] {
  // 같은 글에 두 번 대기를 만들지 않는다. 두 번 달면 사람이 지워야 한다.
  return [...list.filter((p) => p.mediaId !== item.mediaId), item];
}

export function removePending(
  list: readonly PendingReply[],
  mediaId: string,
): PendingReply[] {
  return list.filter((p) => p.mediaId !== mediaId);
}

/** 가장 먼저 올라간 글부터 단다. 오래 기다린 것이 먼저 묻힌다. */
export function pickNext(list: readonly PendingReply[]): PendingReply | undefined {
  return [...list].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))[0];
}

export function elapsedMinutes(item: PendingReply, now: Date = new Date()): number {
  const ms = now.getTime() - new Date(item.publishedAt).getTime();
  return Math.max(0, Math.floor(ms / 60_000));
}

export type Timing = "too-soon" | "good" | "late";

/**
 * 지금 달아도 되나.
 *
 * 막지는 않는다 — 명령을 친 사람이 사정을 안다. 다만 무엇이 걸리는지는 말한다.
 */
export function judgeTiming(minutes: number): { verdict: Timing; note: string } {
  if (minutes < MIN_REPLY_DELAY_MIN) {
    return {
      verdict: "too-soon",
      note: `${minutes}분밖에 안 지났습니다 — ${MIN_REPLY_DELAY_MIN}분은 두는 게 좋습니다. 지금 달면 본문과 같이 올라간 것처럼 보입니다`,
    };
  }
  if (minutes > MAX_REPLY_WINDOW_MIN) {
    return {
      verdict: "late",
      note: `${minutes}분 지났습니다 — ${MAX_REPLY_WINDOW_MIN}분을 넘겼습니다. 본문이 이미 내려가 첫 댓글이 묻힐 수 있습니다`,
    };
  }
  return { verdict: "good", note: `${minutes}분 지났습니다 — 지금이 적당합니다` };
}
