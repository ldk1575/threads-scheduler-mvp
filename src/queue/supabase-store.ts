/**
 * Supabase(Postgres) 발행 큐.
 *
 * 인메모리 구현과 결정적으로 다른 점 — **원자성을 코드가 아니라 DB 가 보장한다.**
 *
 *   중복 등록  INSERT ... ON CONFLICT DO NOTHING  → 삽입된 행이 없으면 이미 있던 것
 *   동시 집기  UPDATE ... WHERE status='queued'   → 갱신된 행 수가 0이면 남이 집었다
 *   결과 기록  DB 함수 mark_publish_success()      → 상태 변경과 기록이 한 트랜잭션
 *
 * 그래서 프로세스가 여럿이어도 안전하다. 인메모리는 그렇지 않다.
 *
 * ⚠️ service role 키로 접속한다. 이 키는 RLS 를 우회하므로 **서버에서만** 쓴다.
 *    브라우저로 내려보내면 DB 전체가 열린다.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildIdempotencyKey, classifyFailure, type ApiFailure } from "../core/publish.ts";
import {
  MAX_RETRIES,
  STUCK_MESSAGE,
  type EnqueueInput,
  type EnqueueResult,
  type Job,
  type JobStore,
  type JobStatus,
  type PostInput,
  type PostRecord,
} from "./job-store.ts";

type JobRow = {
  id: string;
  draft_id: string;
  channel: string;
  channel_account_id: string;
  product_id: string;
  link_id: string | null;
  body_template: string;
  reply_template: string | null;
  scheduled_at: string;
  status: JobStatus;
  retry_count: number;
  last_error: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
};

type PostRow = {
  id: string;
  publish_job_id: string;
  channel: string;
  external_post_id: string;
  permalink: string | null;
  body_final: string;
  reply_external_id: string | null;
  reply_final: string | null;
  published_at: string;
};

function toJob(r: JobRow): Job {
  const job: Job = {
    id: r.id,
    draftId: r.draft_id,
    channel: r.channel,
    channelAccountId: r.channel_account_id,
    productId: r.product_id,
    linkId: r.link_id,
    bodyTemplate: r.body_template,
    scheduledAt: new Date(r.scheduled_at),
    idempotencyKey: r.idempotency_key,
    status: r.status,
    retryCount: r.retry_count,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
  if (r.reply_template != null) job.replyTemplate = r.reply_template;
  if (r.last_error != null) job.lastError = r.last_error;
  return job;
}

function toPost(r: PostRow): PostRecord {
  const p: PostRecord = {
    id: r.id,
    publishJobId: r.publish_job_id,
    channel: r.channel,
    externalPostId: r.external_post_id,
    bodyFinal: r.body_final,
    publishedAt: new Date(r.published_at),
  };
  if (r.permalink != null) p.permalink = r.permalink;
  if (r.reply_external_id != null) p.replyExternalId = r.reply_external_id;
  if (r.reply_final != null) p.replyFinal = r.reply_final;
  return p;
}

export class SupabaseJobStore implements JobStore {
  #db: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.#db = client;
  }

  /**
   * 예약 등록.
   *
   * 조회 후 삽입하지 않는다. 그 사이가 뚫린다.
   * `ignoreDuplicates` 는 `ON CONFLICT DO NOTHING` 으로 내려가며,
   * 충돌하면 빈 배열이 돌아온다 — 그때만 기존 행을 읽는다.
   */
  async enqueue(input: EnqueueInput, now: Date = new Date()): Promise<EnqueueResult> {
    if (input.scheduledAt.getTime() < now.getTime()) {
      throw new Error(
        `E-POST-400: 과거 시각으로는 예약할 수 없다 (${input.scheduledAt.toISOString()})`,
      );
    }

    const key = buildIdempotencyKey(input.draftId, input.channel, input.scheduledAt);
    const row = {
      draft_id: input.draftId,
      channel: input.channel,
      channel_account_id: input.channelAccountId,
      product_id: input.productId,
      link_id: input.linkId ?? null,
      body_template: input.bodyTemplate,
      reply_template: input.replyTemplate ?? null,
      scheduled_at: input.scheduledAt.toISOString(),
      idempotency_key: key,
    };

    const { data, error } = await this.#db
      .from("publish_jobs")
      .upsert(row, { onConflict: "idempotency_key", ignoreDuplicates: true })
      .select();

    if (error) throw new Error(`E-POST-500: 예약 등록 실패 — ${error.message}`);

    if (data && data.length > 0) {
      return { job: toJob(data[0] as JobRow), duplicated: false };
    }

    // 충돌 — 이미 있던 잡을 돌려준다. 사용자는 실패가 아니라 "이미 예약됨"을 본다.
    const existing = await this.#db
      .from("publish_jobs")
      .select()
      .eq("idempotency_key", key)
      .single();

    if (existing.error) {
      throw new Error(`E-POST-500: 기존 잡 조회 실패 — ${existing.error.message}`);
    }
    return { job: toJob(existing.data as JobRow), duplicated: true };
  }

  /**
   * 잡 집기.
   *
   * `status='queued'` 조건을 UPDATE 에 넣고 **갱신된 행 수**로 판정한다.
   * 여럿이 동시에 불러도 Postgres 가 한 쪽만 통과시킨다.
   */
  async claim(jobId: string): Promise<boolean> {
    const { data, error } = await this.#db
      .from("publish_jobs")
      .update({ status: "publishing", updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("status", "queued")
      .select("id");

    if (error) throw new Error(`E-POST-500: 잡 집기 실패 — ${error.message}`);
    return (data?.length ?? 0) > 0;
  }

  /** 발행 성공. 상태 변경과 결과 기록을 DB 함수가 한 트랜잭션으로 처리한다. */
  async markSuccess(jobId: string, post: PostInput): Promise<void> {
    const { error } = await this.#db.rpc("mark_publish_success", {
      p_job_id: jobId,
      p_external_post_id: post.externalPostId,
      p_permalink: post.permalink ?? null,
      p_body_final: post.bodyFinal,
      p_reply_external_id: post.replyExternalId ?? null,
      p_reply_final: post.replyFinal ?? null,
    });
    if (error) throw new Error(`E-POST-500: 성공 기록 실패 — ${error.message}`);
  }

  /**
   * 발행 실패.
   *
   * 영구 실패는 재시도 횟수를 태우지 않는다 —
   * "글자수 초과"를 다섯 번 다시 보내 봐야 답은 같고 쿼터만 없어진다.
   */
  async markFailure(jobId: string, err: ApiFailure): Promise<void> {
    const message = `[${err.status}] ${err.message}`;

    if (classifyFailure(err) === "permanent") {
      const { error } = await this.#db
        .from("publish_jobs")
        .update({ status: "failed", last_error: message, updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .not("status", "in", "(dead,failed)");
      if (error) throw new Error(`E-POST-500: 실패 기록 실패 — ${error.message}`);
      return;
    }

    // 일시 실패 — 현재 횟수를 읽어 다음 상태를 정한다.
    const cur = await this.#db
      .from("publish_jobs")
      .select("retry_count,status")
      .eq("id", jobId)
      .single();
    if (cur.error) throw new Error(`E-POST-500: 잡 조회 실패 — ${cur.error.message}`);

    const row = cur.data as { retry_count: number; status: JobStatus };
    if (row.status === "dead" || row.status === "failed") return;

    const next = row.retry_count + 1;
    const { error } = await this.#db
      .from("publish_jobs")
      .update({
        retry_count: next,
        status: next >= MAX_RETRIES ? "dead" : "queued",
        last_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .eq("retry_count", row.retry_count); // 그 사이 남이 올렸으면 덮어쓰지 않는다

    if (error) throw new Error(`E-POST-500: 재시도 기록 실패 — ${error.message}`);
  }

  async markDeferred(jobId: string, reason: string): Promise<void> {
    const { error } = await this.#db
      .from("publish_jobs")
      .update({
        status: "queued",
        last_error: `deferred: ${reason}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);
    if (error) throw new Error(`E-POST-500: 보류 기록 실패 — ${error.message}`);
  }

  async recoverStuck(): Promise<number> {
    const { data, error } = await this.#db
      .from("publish_jobs")
      .update({ status: "failed", last_error: STUCK_MESSAGE, updated_at: new Date().toISOString() })
      .eq("status", "publishing")
      .select("id");
    if (error) throw new Error(`E-POST-500: 중단 복구 실패 — ${error.message}`);
    return data?.length ?? 0;
  }

  async due(now: Date = new Date()): Promise<Job[]> {
    const { data, error } = await this.#db
      .from("publish_jobs")
      .select()
      .eq("status", "queued")
      .lte("scheduled_at", now.toISOString())
      .order("scheduled_at", { ascending: true });
    if (error) throw new Error(`E-POST-500: 대기 잡 조회 실패 — ${error.message}`);
    return (data as JobRow[]).map(toJob);
  }

  async get(jobId: string): Promise<Job | undefined> {
    const { data, error } = await this.#db
      .from("publish_jobs")
      .select()
      .eq("id", jobId)
      .maybeSingle();
    if (error) throw new Error(`E-POST-500: 잡 조회 실패 — ${error.message}`);
    return data ? toJob(data as JobRow) : undefined;
  }

  async posts(): Promise<PostRecord[]> {
    const { data, error } = await this.#db.from("posts").select();
    if (error) throw new Error(`E-POST-500: 결과 조회 실패 — ${error.message}`);
    return (data as PostRow[]).map(toPost);
  }
}
