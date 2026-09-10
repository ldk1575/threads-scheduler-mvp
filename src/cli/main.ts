/**
 * 실행 진입점.
 *
 *   npm run cli -- connect            토큰 확인 · 남은 쿼터 조회
 *   npm run cli -- generate "<주제>"   글 3종 생성 → 검증 → .data/drafts.json 저장
 *   npm run cli -- publish 1          1번 글을 실제로 발행
 *   npm run cli -- publish 1 --dry    발행 직전까지만 (실제로 안 올림)
 *
 * ⚠️ `publish` 는 **실제 계정에 글이 올라간다.** 되돌리려면 손으로 지워야 한다.
 *    그래서 기본 흐름은 generate → 눈으로 확인 → publish 로 나눠 뒀다.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { ThreadsClient } from "../threads/client.ts";
import { buildTopicPrompt, validateTopicPosts } from "../content/topic.ts";
import { extractJson, generate } from "../llm/provider.ts";
import { makeApiCaller, makeCliRunner, readLlmOptions } from "../llm/runners.ts";
import { decideQuota, injectTrackingLink, THREADS_MAX_CHARS } from "../core/publish.ts";
import { countChars } from "../content/threads.ts";
import { screen } from "../content/safety.ts";
import {
  addPending,
  elapsedMinutes,
  judgeTiming,
  pickNext,
  removePending,
  type PendingReply,
} from "../core/pending-replies.ts";
import type { ThreadsPost } from "../content/threads.ts";

const DRAFTS = ".data/drafts.json";
const PENDING = ".data/pending-replies.json";

/**
 * `.env` 값을 읽되 **빈 줄은 없는 것으로 친다.**
 *
 * dotenv 는 `KEY=` 를 빈 문자열로 넣는다. `??` 는 null 만 걸러내므로 빈 문자열이
 * 그대로 통과한다. `.env.example` 을 복사해 붙이고 몇 줄을 안 채운 사람은
 * 기본값 대신 `""` 를 받게 된다 — 프롬프트에 `타겟:` 뒤가 비어 나가고,
 * `userId` 는 빈 채로 URL 에 박힌다. 값이 있는지의 판정을 여기 한 곳에 모은다.
 */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function need(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`${name} 가 .env 에 없다`);
  return v;
}

function client(): ThreadsClient {
  return new ThreadsClient({
    // 대부분의 엔드포인트가 `me` 를 받는다. 명시하면 그걸 쓴다.
    userId: env("THREADS_USER_ID") ?? "me",
    accessToken: need("THREADS_ACCESS_TOKEN"),
  });
}

function llm() {
  return {
    opts: readLlmOptions(),
    deps: {
      runCli: makeCliRunner(),
      callApi: makeApiCaller(),
      log: (l: string) => console.log(`  ${l}`),
    },
  };
}

// ── connect ────────────────────────────────────────────────
async function cmdConnect(): Promise<void> {
  const c = client();

  const me = await c.me();
  console.log(`\n연결됨 — @${me.username ?? "(username 없음)"} (id ${me.id})`);

  const limit = await c.getPublishingLimit();
  const q = decideQuota(limit);
  if (limit) {
    console.log(`쿼터 — ${limit.quota_usage} / ${limit.quota_total} 사용, 남음 ${q.remaining}`);
  } else {
    console.log("쿼터 — 응답을 읽지 못했다. 발행 시 보수적으로 미룬다");
  }
  console.log(q.action === "publish" ? "→ 발행 가능\n" : "→ 지금은 발행할 수 없다\n");
}

// ── generate ───────────────────────────────────────────────
async function cmdGenerate(topic: string): Promise<void> {
  if (!topic) throw new Error('주제를 주세요: npm run cli -- generate "주제"');

  const recent = readRecentHooks();
  const experience = env("PERSONA_EXPERIENCE");
  const category = env("PERSONA_CATEGORY");
  const prompt = buildTopicPrompt(
    {
      topic,
      audience: env("PERSONA_AUDIENCE") ?? "이 주제에 관심 있는 사람",
      tone: env("PERSONA_TONE") ?? "친구에게 카톡하듯",
      ...(experience ? { experience } : {}),
      ...(category ? { category } : {}),
      withLink: Boolean(env("TRACKING_LINK")),
    },
    { recentHooks: recent },
  );

  console.log(`\n주제: ${topic}`);
  console.log(`훅 3종: ${prompt.hooks.map((h) => `${h.id} ${h.name}`).join(" / ")}`);
  if (recent.length) console.log(`(최근 쓴 훅 회피: ${recent.join(", ")})`);

  const { opts, deps } = llm();
  console.log(`\n생성 중 — ${opts.primary}${opts.secondary ? ` → ${opts.secondary}` : ""}`);

  /**
   * 한 번 더 시도한다.
   *
   * 글 3개 중 하나만 규칙을 어겨도 배치가 통째로 거절된다.
   * 그때 사람이 다시 치게 두는 대신, **무엇이 틀렸는지 모델에게 돌려주고** 다시 받는다.
   * 그래도 안 되면 그때 사람이 판단한다.
   */
  async function ask(extra = ""): Promise<{ posts: ThreadsPost[]; provider: string }> {
    const res = await generate(prompt.system, prompt.user + extra, opts, deps);
    if (process.env["LLM_DEBUG"]) {
      console.log("--- 모델이 준 원문 ---");
      console.log(res.text);
      console.log("--- 끝 ---");
    }
    const parsed = extractJson<{ posts?: ThreadsPost[] }>(res.text);
    return {
      posts: parsed.posts ?? [],
      provider: `${res.usedProvider}${res.fellBack ? " (폴백)" : ""}`,
    };
  }

  const withLink = Boolean(env("TRACKING_LINK"));
  let { posts, provider } = await ask();
  let gate = validateTopicPosts(posts, withLink);

  if (!gate.ok) {
    console.log(`응답: ${provider} — 검증 실패, 고쳐서 다시 요청합니다`);
    for (const e of gate.errors) console.log(`  ✗ ${e}`);

    const feedback =
      "\n[재작성 요구] 앞서 만든 글이 아래를 어겼다. 그 점만 고쳐서 3개를 다시 만들어라.\n" +
      gate.errors.map((e) => `- ${e}`).join("\n");

    ({ posts, provider } = await ask(feedback));
    gate = validateTopicPosts(posts, withLink);
    console.log();
  }

  console.log(`응답: ${provider}\n`);

  posts.forEach((p, i) => {
    console.log(`── ${i + 1}. ${p.hook_type} · ${p.structure} · ${p.text.length}자 · ${p.cta_kind}`);
    console.log(p.text.split("\n").map((l) => `   ${l}`).join("\n"));
    if (p.first_comment) {
      console.log(`\n   └ 첫 댓글 (${p.first_comment.length}자)`);
      console.log(p.first_comment.split("\n").map((l) => `     ${l}`).join("\n"));
    }
    console.log();
  });

  if (gate.warnings.length) {
    console.log("경고:");
    for (const w of gate.warnings) console.log(`  · ${w}`);
    console.log();
  }

  if (!gate.ok) {
    console.log("검증 실패 — 저장하지 않는다:");
    for (const e of gate.errors) console.log(`  ✗ ${e}`);
    console.log("\n다시 생성해 보세요.\n");
    process.exitCode = 1;
    return;
  }

  // 안전 필터 — 브랜드를 태울 소재인지 본다
  const verdict = await screen(posts.map((p) => p.text).join("\n"), opts, deps);
  if (!verdict.ai_use) {
    console.log(`안전 필터에 걸렸다 (${verdict.stage}) — ${verdict.ai_skip_reason}\n`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(".data", { recursive: true });
  writeFileSync(
    DRAFTS,
    JSON.stringify({ topic, generatedAt: new Date().toISOString(), posts: gate.posts }, null, 2),
    "utf8",
  );
  console.log(`검증 통과 · 안전 필터 통과 → ${DRAFTS} 에 저장했다`);
  console.log(`발행하려면: npm run cli -- publish 1\n`);
}

// ── publish ────────────────────────────────────────────────
async function cmdPublish(indexArg: string, dry: boolean, withReply: boolean): Promise<void> {
  if (!existsSync(DRAFTS)) throw new Error(`${DRAFTS} 가 없다. 먼저 generate 하세요`);

  const saved = JSON.parse(readFileSync(DRAFTS, "utf8")) as {
    topic: string;
    posts: ThreadsPost[];
  };
  const i = Number(indexArg);
  const post = saved.posts[i - 1];
  if (!post) throw new Error(`${i}번 글이 없다 (1~${saved.posts.length})`);

  const link = env("TRACKING_LINK");
  const text = link
    ? injectTrackingLink(post.text, link, THREADS_MAX_CHARS).text
    : post.text;

  const comment = post.first_comment?.trim();

  console.log(`\n올릴 글 (${countChars(text)}자):\n`);
  console.log(text.split("\n").map((l) => `   ${l}`).join("\n"));
  console.log();

  if (comment) {
    console.log(`이어서 달 첫 댓글 (${countChars(comment)}자):\n`);
    console.log(comment.split("\n").map((l) => `   ${l}`).join("\n"));
    console.log();
  } else {
    console.log("첫 댓글 없음 — 본문만 올라간다.\n");
  }

  if (dry) {
    console.log("--dry — 여기까지. 실제로 올리지 않았다.\n");
    return;
  }

  const c = client();

  // 쿼터 먼저. 못 쏠 거면 컨테이너도 만들지 않는다.
  const q = decideQuota(await c.getPublishingLimit());
  if (q.action === "defer") {
    console.log("쿼터가 없다 — 발행하지 않는다.\n");
    process.exitCode = 1;
    return;
  }
  console.log(`쿼터 남음 ${q.remaining} → 발행합니다...`);

  const r = await c.publishText(text);
  console.log(`\n✓ 올라갔습니다`);
  console.log(`  media id : ${r.mediaId}`);
  console.log(`  permalink: ${r.permalink ?? "(조회 실패 — 프로필에서 확인하세요)"}`);

  // ── 여기서부터 본문은 이미 올라갔다 ─────────────────────
  // 아래가 실패해도 명령 전체를 실패로 만들면 안 된다.
  // 사람이 "실패했네" 하고 다시 돌리면 본문이 두 번 올라간다.
  // 워커(publish-due.ts)가 쓰는 규칙과 같다.
  if (!comment) {
    console.log();
  } else if (withReply) {
    // 예전 동작. 본문과 같은 분에 나가므로 봇 티가 난다.
    try {
      const rc = await c.replyTo(r.mediaId, comment);
      console.log(`  첫 댓글  : 달렸습니다 (${rc.mediaId})\n`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.log(`  첫 댓글  : ✗ 실패 — ${m}`);
      console.log("           본문은 이미 올라갔습니다. 다시 돌리지 말고 손으로 다세요.\n");
    }
  } else {
    writePending(
      addPending(readPending(), {
        mediaId: r.mediaId,
        ...(r.permalink ? { permalink: r.permalink } : {}),
        topic: saved.topic,
        hookType: post.hook_type,
        text: comment,
        publishedAt: new Date().toISOString(),
      }),
    );
    console.log(`  첫 댓글  : 대기로 남겼습니다 — 20~120분 뒤에 아래 명령으로 다세요`);
    console.log(`             npm run cli -- reply\n`);
  }

  rememberHook(post.hook_type);
}

// ── reply / pending ────────────────────────────────────────
function readPending(): PendingReply[] {
  if (!existsSync(PENDING)) return [];
  try {
    return JSON.parse(readFileSync(PENDING, "utf8")) as PendingReply[];
  } catch {
    return [];
  }
}

function writePending(list: readonly PendingReply[]): void {
  mkdirSync(".data", { recursive: true });
  writeFileSync(PENDING, JSON.stringify(list, null, 2), "utf8");
}

function cmdPending(): void {
  const list = readPending();
  if (!list.length) {
    console.log("\n대기 중인 첫 댓글이 없습니다.\n");
    return;
  }
  console.log(`\n대기 중인 첫 댓글 ${list.length}건\n`);
  for (const p of list) {
    const { note } = judgeTiming(elapsedMinutes(p));
    console.log(`  ${p.hookType} — ${p.topic}`);
    console.log(`    ${note}`);
    console.log(`    ${p.text.slice(0, 40)}...`);
    console.log(`    ${p.permalink ?? p.mediaId}\n`);
  }
}

/**
 * 대기 중인 첫 댓글 하나를 단다. 가장 먼저 올라간 글부터.
 *
 * 시점이 이르거나 늦으면 말은 하되 막지는 않는다 — 명령을 친 사람이 사정을 안다.
 */
async function cmdReply(dry: boolean): Promise<void> {
  const list = readPending();
  const next = pickNext(list);
  if (!next) {
    console.log("\n대기 중인 첫 댓글이 없습니다.\n");
    return;
  }

  const { verdict, note } = judgeTiming(elapsedMinutes(next));
  console.log(`\n대상: ${next.hookType} — ${next.topic}`);
  console.log(`${verdict === "good" ? "" : "⚠️  "}${note}\n`);
  console.log(`달 첫 댓글 (${countChars(next.text)}자):\n`);
  console.log(next.text.split("\n").map((l) => `   ${l}`).join("\n"));
  console.log();

  if (dry) {
    console.log("--dry — 여기까지. 실제로 달지 않았다.\n");
    return;
  }

  const rc = await client().replyTo(next.mediaId, next.text);
  // 성공한 뒤에만 목록에서 뺀다. 실패하면 대기로 남아 다시 시도할 수 있다.
  writePending(removePending(list, next.mediaId));
  console.log(`✓ 달렸습니다 (${rc.mediaId})\n`);
}

// ── 훅 로테이션 기록 ───────────────────────────────────────
const HOOKS_FILE = ".data/recent-hooks.json";

function readRecentHooks(): string[] {
  if (!existsSync(HOOKS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(HOOKS_FILE, "utf8")) as string[];
  } catch {
    return [];
  }
}

/** 최신이 앞. 같은 훅을 연달아 쓰지 않게 5개까지 기억한다. */
function rememberHook(hookType: string): void {
  const id = /^H\d+/.exec(hookType)?.[0];
  if (!id) return;
  const next = [id, ...readRecentHooks().filter((h) => h !== id)].slice(0, 5);
  mkdirSync(".data", { recursive: true });
  writeFileSync(HOOKS_FILE, JSON.stringify(next), "utf8");
}

// ── 진입 ───────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const dry = rest.includes("--dry");
const withReply = rest.includes("--with-reply");
const args = rest.filter((a) => !a.startsWith("--"));

try {
  if (cmd === "connect") await cmdConnect();
  else if (cmd === "generate") await cmdGenerate(args.join(" "));
  else if (cmd === "publish") await cmdPublish(args[0] ?? "", dry, withReply);
  else if (cmd === "reply") await cmdReply(dry);
  else if (cmd === "pending") cmdPending();
  else {
    console.log(`
사용법
  npm run cli -- connect              토큰 확인 · 쿼터 조회
  npm run cli -- generate "<주제>"     글 3종 생성 → 검증 → 저장
  npm run cli -- publish <번호>        실제 발행
  npm run cli -- publish <번호> --dry  발행 직전까지만
  npm run cli -- pending              대기 중인 첫 댓글 보기
  npm run cli -- reply                대기 중 첫 댓글 하나 달기 (20~120분 뒤)

첫 댓글은 본문과 같이 나가지 않는다. 같은 분에 올라가면 봇 티가 난다.
  publish <번호> --with-reply         (예전 동작) 첫 댓글까지 한 번에
`);
  }
} catch (e) {
  console.error(`\n실패: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
