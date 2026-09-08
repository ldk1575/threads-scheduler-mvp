/**
 * 발행 큐 저장소 (로컬 MVP 구현).
 *
 * ⚠️ 이 구현의 원자성은 "자바스크립트가 한 번에 한 줄만 실행한다"는 성질에 기댄다.
 * 아래 두 함수는 검사와 변경 사이에 **await 를 두지 않는다.** 한 줄이라도 끼면
 * 그 틈으로 중복이 들어온다 — 어제 정원 초과가 뚫리던 것과 같은 자리다.
 *
 * 프로세스가 여럿이면 이 보장은 깨진다. 이관 시에는
 * `publish_jobs.idempotency_key` 의 DB **unique 제약**이 유일한 진실이 되고,
 * 잡 집기는 `status='queued' → 'publishing'` 조건부 UPDATE 의 갱신 행 수로 판정한다.
 */

import {
  buildIdempotencyKey,
  classifyFailure,
  type ApiFailure,
} from "../core/publish.ts";

export type {
  JobStatus,
  EnqueueInput,
  Job,
  PostInput,
  PostRecord,
  EnqueueResult,
  JobStore,
} from "./job-store.ts";

import type {
  EnqueueInput,
  EnqueueResult,
  Job,
  JobStore,
  PostInput,
  PostRecord,
} from "./job-store.ts";
import { MAX_RETRIES, STUCK_MESSAGE } from "./job-store.ts";

export class MemoryJobStore implements JobStore {
  #jobs = new Map<string, Job>();
  /** idempotencyKey → jobId. 이 맵이 중복 발행을 막는 자물쇠다. */
  #byKey = new Map<string, string>();
  #posts: PostRecord[] = [];
  #seq = 0;

  #nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_${String(this.#seq).padStart(4, "0")}`;
  }

  /**
   * 예약을 등록한다. 같은 키가 이미 있으면 새로 만들지 않고 기존 잡을 돌려준다.
   * 사용자는 실패가 아니라 "이미 예약됨"을 본다.
   */
  async enqueue(
    input: EnqueueInput,
    now: Date = new Date(),
  ): Promise<EnqueueResult> {
    if (input.scheduledAt.getTime() < now.getTime()) {
      throw new Error(
        `E-POST-400: 과거 시각으로는 예약할 수 없다 (${input.scheduledAt.toISOString()})`,
      );
    }

    const key = buildIdempotencyKey(input.draftId, input.channel, input.scheduledAt);

    // ── 여기부터 await 금지 ────────────────────────────────
    const existingId = this.#byKey.get(key);
    if (existingId !== undefined) {
      return { job: this.#jobs.get(existingId)!, duplicated: true };
    }

    const job: Job = {
      ...input,
      id: this.#nextId("job"),
      idempotencyKey: key,
      status: "queued",
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.#byKey.set(key, job.id);
    this.#jobs.set(job.id, job);
    // ── 여기까지 ──────────────────────────────────────────

    return { job, duplicated: false };
  }

  /**
   * 잡을 집는다. `queued` 일 때만 성공하며, 여럿이 동시에 불러도 하나만 true 를 받는다.
   */
  async claim(jobId: string): Promise<boolean> {
    // ── await 금지 구간 ───────────────────────────────────
    const job = this.#jobs.get(jobId);
    if (!job || job.status !== "queued") return false;

    job.status = "publishing";
    job.updatedAt = new Date();
    return true;
    // ─────────────────────────────────────────────────────
  }

  /** 발행 성공. 같은 잡을 두 번 처리해도 posts 는 늘지 않는다. */
  async markSuccess(jobId: string, post: PostInput): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`E-POST-404: 잡이 없다 (${jobId})`);
    if (job.status === "success") return;

    job.status = "success";
    job.updatedAt = new Date();

    this.#posts.push({
      ...post,
      id: this.#nextId("post"),
      publishJobId: job.id,
      channel: job.channel,
      publishedAt: job.updatedAt,
    });
  }

  /**
   * 발행 실패.
   * 영구 실패는 재시도 횟수를 태우지 않고 즉시 접는다 —
   * "글자수 초과"를 다섯 번 다시 보내 봐야 답은 같고 쿼터만 없어진다.
   */
  async markFailure(jobId: string, err: ApiFailure): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`E-POST-404: 잡이 없다 (${jobId})`);
    if (job.status === "dead" || job.status === "failed") return;

    job.lastError = `[${err.status}] ${err.message}`;
    job.updatedAt = new Date();

    if (classifyFailure(err) === "permanent") {
      job.status = "failed";
      return;
    }

    job.retryCount += 1;
    job.status = job.retryCount >= MAX_RETRIES ? "dead" : "queued";
  }

  /**
   * 쿼터 소진 등으로 미룬다.
   * 실패가 아니므로 재시도 횟수를 올리지 않는다 — 우리 잘못이 아니라 창이 닫힌 것뿐이다.
   */
  async markDeferred(jobId: string, reason: string): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`E-POST-404: 잡이 없다 (${jobId})`);

    job.status = "queued";
    job.lastError = `deferred: ${reason}`;
    job.updatedAt = new Date();
  }

  /**
   * 중단 복구. 워커가 발행 도중 죽으면 `publishing` 상태가 남는다.
   *
   * 자동으로 재발행하지 않는다 — 이미 올라갔을 수도 있고, 그러면 같은 글이 두 번 뜬다.
   * 사람이 확인하게 남긴다.
   */
  recoverStuck(): number {
    let n = 0;
    for (const job of this.#jobs.values()) {
      if (job.status !== "publishing") continue;
      job.status = "failed";
      job.lastError = STUCK_MESSAGE;
      job.updatedAt = new Date();
      n += 1;
    }
    return n;
  }

  /** 발행 시각이 된 대기 잡들 */
  due(now: Date = new Date()): Job[] {
    return [...this.#jobs.values()].filter(
      (j) => j.status === "queued" && j.scheduledAt.getTime() <= now.getTime(),
    );
  }

  get(jobId: string): Job | undefined {
    return this.#jobs.get(jobId);
  }

  jobs(): Job[] {
    return [...this.#jobs.values()];
  }

  posts(): PostRecord[] {
    return [...this.#posts];
  }

  countJobs(): number {
    return this.#jobs.size;
  }
}
