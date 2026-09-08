/**
 * 배포 워커 — 예약 시각이 된 잡을 집어 실제로 발행한다.
 *
 * 순서가 중요하다.
 *   집기(claim) → 쿼터 확인 → 링크 주입 → 2단계 발행 → 결과 기록
 *
 * 쿼터 확인을 링크 주입보다 **먼저** 한다. 못 쏠 거면 아무것도 만들지 않는다.
 */

import {
  decideQuota,
  injectTrackingLink,
  THREADS_MAX_CHARS,
  type ApiFailure,
} from "../core/publish.ts";
import type { Job, MemoryJobStore } from "../queue/store.ts";
import { ThreadsApiError, type ThreadsClient } from "../threads/client.ts";

export type WorkerDeps = {
  store: MemoryJobStore;
  /** 잡의 채널 계정에 맞는 클라이언트를 준다 */
  clientFor: (channelAccountId: string) => ThreadsClient;
  /** 잡의 추적 링크 URL 을 준다 */
  resolveLink: (job: Job) => string;
  log?: (line: string) => void;
};

export type WorkerResult = {
  claimed: number;
  published: number;
  deferred: number;
  failed: number;
};

function toApiFailure(e: unknown): ApiFailure {
  if (e instanceof ThreadsApiError) return { status: e.status, message: e.message };
  if (e instanceof Error) return { status: 0, message: e.message };
  return { status: 0, message: String(e) };
}

export async function processDueJobs(
  deps: WorkerDeps,
  now: Date = new Date(),
): Promise<WorkerResult> {
  const { store, clientFor, resolveLink } = deps;
  const log = deps.log ?? (() => {});
  const result: WorkerResult = { claimed: 0, published: 0, deferred: 0, failed: 0 };

  for (const job of store.due(now)) {
    // 다른 워커가 이미 집었으면 조용히 넘어간다
    if (!(await store.claim(job.id))) continue;
    result.claimed += 1;

    const client = clientFor(job.channelAccountId);

    try {
      const limit = await client.getPublishingLimit();
      const quota = decideQuota(limit);
      if (quota.action === "defer") {
        await store.markDeferred(job.id, "발행 쿼터 소진 — 다음 창으로 미룸");
        result.deferred += 1;
        log(`[defer] ${job.id} 쿼터 남음 ${quota.remaining}`);
        continue;
      }

      const link = resolveLink(job);
      const hasReply = (job.replyTemplate ?? "").trim().length > 0;

      // 본문=후킹 / 첫 댓글=본론 패턴이면 링크는 본문이 아니라 첫 댓글에 넣는다.
      // 본문이 짧을수록 끝까지 읽히고, 링크가 본문에 없으면 도달이 덜 눌린다.
      const bodyFinal = hasReply
        ? job.bodyTemplate
        : injectTrackingLink(job.bodyTemplate, link, THREADS_MAX_CHARS).text;

      const published = await client.publishText(bodyFinal);

      // ── 여기서부터 본문은 이미 올라갔다 ─────────────────────
      // 아래가 실패해도 잡을 실패로 되돌리면 안 된다. 재시도하면 본문이 두 번 올라간다.
      let replyExternalId: string | undefined;
      let replyFinal: string | undefined;

      if (hasReply) {
        try {
          const injected = injectTrackingLink(job.replyTemplate!, link, THREADS_MAX_CHARS);
          if (injected.truncated) log(`[warn] ${job.id} 링크를 넣느라 첫 댓글을 잘랐다`);
          replyFinal = injected.text;
          replyExternalId = (await client.replyTo(published.mediaId, replyFinal)).mediaId;
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          log(`[warn] ${job.id} 본문은 올라갔으나 첫 댓글 실패: ${m} — 손으로 달아야 한다`);
        }
      }

      await store.markSuccess(job.id, {
        externalPostId: published.mediaId,
        permalink: published.permalink,
        bodyFinal,
        replyExternalId,
        replyFinal,
      });
      result.published += 1;
      log(`[ok] ${job.id} → ${published.permalink ?? published.mediaId}${hasReply && replyExternalId ? " (+첫 댓글)" : ""}`);
    } catch (e) {
      const failure = toApiFailure(e);
      await store.markFailure(job.id, failure);
      result.failed += 1;
      log(`[fail] ${job.id} [${failure.status}] ${failure.message}`);
    }
  }

  return result;
}
