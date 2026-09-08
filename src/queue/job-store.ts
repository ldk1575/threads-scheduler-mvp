/**
 * 발행 큐의 계약.
 *
 * 구현이 둘이다.
 *   MemoryJobStore   — 설정 없이 도는 기본값. 원자성은 "await 를 안 끼운다"는 규율에 기댄다.
 *   SupabaseJobStore — 실제 배포용. 원자성을 DB 제약이 강제한다.
 *
 * 둘은 `contract.test.ts` 의 같은 테스트를 통과해야 한다.
 * 그래야 "로컬에서 됐는데 배포하면 다르다"가 안 생긴다.
 */

import type { ApiFailure } from "../core/publish.ts";

export type JobStatus =
  | "queued"
  | "publishing"
  | "success"
  | "failed"
  | "dead"
  | "cancelled";

export type EnqueueInput = {
  draftId: string;
  channel: string;
  channelAccountId: string;
  productId: string;
  linkId?: string | null;
  bodyTemplate: string;
  /** 첫 댓글 본론. 있으면 링크는 본문이 아니라 여기에 들어간다. */
  replyTemplate?: string;
  scheduledAt: Date;
};

export type Job = EnqueueInput & {
  id: string;
  idempotencyKey: string;
  status: JobStatus;
  retryCount: number;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PostInput = {
  externalPostId: string;
  permalink?: string;
  bodyFinal: string;
  /** 첫 댓글을 달았다면 그 id */
  replyExternalId?: string;
  /** 첫 댓글의 실제 발행 본문 */
  replyFinal?: string;
};

export type PostRecord = PostInput & {
  id: string;
  publishJobId: string;
  channel: string;
  publishedAt: Date;
};

export type EnqueueResult = { job: Job; duplicated: boolean };

export interface JobStore {
  /** 예약 등록. 같은 키가 있으면 새로 만들지 않고 기존 잡을 돌려준다. */
  enqueue(input: EnqueueInput, now?: Date): Promise<EnqueueResult>;

  /** 잡을 집는다. `queued` 일 때만 true. 여럿이 동시에 불러도 하나만 성공한다. */
  claim(jobId: string): Promise<boolean>;

  /** 발행 성공. 두 번 불려도 결과 기록은 하나만 남는다. */
  markSuccess(jobId: string, post: PostInput): Promise<void>;

  /** 발행 실패. 영구 실패는 재시도 횟수를 태우지 않고 즉시 접는다. */
  markFailure(jobId: string, err: ApiFailure): Promise<void>;

  /** 쿼터 소진 등으로 미룸. 실패가 아니므로 재시도 횟수를 올리지 않는다. */
  markDeferred(jobId: string, reason: string): Promise<void>;

  /** 발행 시각이 된 대기 잡들 */
  due(now?: Date): Promise<Job[]> | Job[];

  get(jobId: string): Promise<Job | undefined> | Job | undefined;

  posts(): Promise<PostRecord[]> | PostRecord[];

  /**
   * 중단 복구. 워커가 발행 도중 죽으면 `publishing` 이 남는다.
   * 자동 재발행하지 않는다 — 이미 올라갔을 수 있어 사람이 확인해야 한다.
   */
  recoverStuck(): Promise<number> | number;
}

/** 재시도 상한. 두 구현이 같은 값을 써야 한다. */
export const MAX_RETRIES = 5;

/** 중단 복구 시 남기는 문구 */
export const STUCK_MESSAGE =
  "발행 도중 중단됨 — 이미 게시됐을 수 있으니 프로필을 확인한 뒤 다시 예약하세요";
