-- 발행 큐 스키마
--
-- 인메모리 구현은 "검사와 변경 사이에 await 를 두지 않는다"는 규율에 기댄다.
-- 프로세스가 여럿이면 그 보장은 깨진다. 여기서는 **DB 제약이 유일한 진실**이다.
--
--   중복 등록 차단  → idempotency_key 의 UNIQUE 제약
--   동시 집기 차단  → status 조건부 UPDATE 의 갱신 행 수
--   중복 기록 차단  → posts.publish_job_id 의 UNIQUE 제약
--
-- 적용: Supabase 대시보드 → SQL Editor 에 붙여넣고 실행

-- ── 상태 ─────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'publish_status') then
    create type publish_status as enum (
      'queued', 'publishing', 'success', 'failed', 'dead', 'cancelled'
    );
  end if;
end$$;

-- ── 발행 잡 ──────────────────────────────────────────────
create table if not exists publish_jobs (
  id                 uuid primary key default gen_random_uuid(),
  draft_id           text        not null,
  channel            text        not null,
  channel_account_id text        not null,
  product_id         text        not null,
  link_id            text,
  body_template      text        not null,
  -- 첫 댓글 본론. 있으면 링크는 본문이 아니라 여기에 들어간다.
  reply_template     text,
  scheduled_at       timestamptz not null,
  status             publish_status not null default 'queued',
  retry_count        int         not null default 0,
  last_error         text,

  -- ★ 중복 발행을 막는 자물쇠.
  --   draft_id : channel : scheduled_at 을 5분 단위로 내린 값
  --   애플리케이션에서 "조회 후 삽입"하면 그 사이가 뚫린다.
  --   반드시 INSERT ... ON CONFLICT 로 처리한다.
  idempotency_key    text        not null unique,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- 워커가 매번 도는 질의. 상태와 시각으로 좁힌다.
create index if not exists publish_jobs_due_idx
  on publish_jobs (status, scheduled_at);

-- ── 발행 결과 ────────────────────────────────────────────
create table if not exists posts (
  id               uuid primary key default gen_random_uuid(),
  -- ★ 잡 하나당 결과 하나. markSuccess 가 두 번 불려도 행은 늘지 않는다.
  publish_job_id   uuid        not null unique references publish_jobs(id) on delete cascade,
  channel          text        not null,
  external_post_id text        not null,
  permalink        text,
  body_final       text        not null,
  reply_external_id text,
  reply_final      text,
  published_at     timestamptz not null default now()
);

-- ── 발행 성공 기록 (원자적) ──────────────────────────────
--
-- 잡 상태 변경과 결과 기록이 한 트랜잭션 안에서 일어나야 한다.
-- 나뉘면 "잡은 성공인데 기록이 없는" 상태가 생기고, 그러면
-- 무엇이 올라갔는지 알 수 없게 된다.
--
-- 이미 success 인 잡은 아무것도 하지 않는다(멱등).
create or replace function mark_publish_success(
  p_job_id            uuid,
  p_external_post_id  text,
  p_permalink         text,
  p_body_final        text,
  p_reply_external_id text default null,
  p_reply_final       text default null
) returns boolean
language plpgsql
as $$
declare
  v_channel text;
begin
  -- publishing 인 잡만 성공으로 넘긴다. 이미 success 면 false 를 돌려준다.
  update publish_jobs
     set status = 'success', updated_at = now()
   where id = p_job_id
     and status <> 'success'
  returning channel into v_channel;

  if not found then
    return false;
  end if;

  insert into posts (
    publish_job_id, channel, external_post_id, permalink,
    body_final, reply_external_id, reply_final
  ) values (
    p_job_id, v_channel, p_external_post_id, p_permalink,
    p_body_final, p_reply_external_id, p_reply_final
  )
  on conflict (publish_job_id) do nothing;

  return true;
end;
$$;

-- ── 행 수준 보안 ─────────────────────────────────────────
--
-- 켜지 않으면 anon 키를 가진 누구나 전체를 읽고 쓴다.
-- 이 MVP 는 서버(service role)에서만 접근하므로 정책을 열지 않는다.
-- service role 은 RLS 를 우회하므로 워커는 그대로 동작한다.
alter table publish_jobs enable row level security;
alter table posts        enable row level security;
