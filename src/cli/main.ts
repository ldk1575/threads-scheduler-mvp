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
import { screen } from "../content/safety.ts";
import type { ThreadsPost } from "../content/threads.ts";

const DRAFTS = ".data/drafts.json";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} 가 .env 에 없다`);
  return v;
}

function client(): ThreadsClient {
  return new ThreadsClient({
    // 대부분의 엔드포인트가 `me` 를 받는다. 명시하면 그걸 쓴다.
    userId: process.env["THREADS_USER_ID"] ?? "me",
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
  const prompt = buildTopicPrompt(
    {
      topic,
      audience: process.env["PERSONA_AUDIENCE"] ?? "이 주제에 관심 있는 사람",
      tone: process.env["PERSONA_TONE"] ?? "친구에게 카톡하듯",
      ...(process.env["PERSONA_EXPERIENCE"]
        ? { experience: process.env["PERSONA_EXPERIENCE"] }
        : {}),
      withLink: Boolean(process.env["TRACKING_LINK"]),
    },
    { recentHooks: recent },
  );

  console.log(`\n주제: ${topic}`);
  console.log(`훅 3종: ${prompt.hooks.map((h) => `${h.id} ${h.name}`).join(" / ")}`);
  if (recent.length) console.log(`(최근 쓴 훅 회피: ${recent.join(", ")})`);

  const { opts, deps } = llm();
  console.log(`\n생성 중 — ${opts.primary}${opts.secondary ? ` → ${opts.secondary}` : ""}`);

  const res = await generate(prompt.system, prompt.user, opts, deps);
  const parsed = extractJson<{ posts?: ThreadsPost[] }>(res.text);
  const posts = parsed.posts ?? [];
  console.log(`응답: ${res.usedProvider}${res.fellBack ? " (폴백)" : ""}\n`);

  const gate = validateTopicPosts(posts, Boolean(process.env["TRACKING_LINK"]));

  posts.forEach((p, i) => {
    console.log(`── ${i + 1}. ${p.hook_type} · ${p.structure} · ${p.text.length}자 · ${p.cta_kind}`);
    console.log(p.text.split("\n").map((l) => `   ${l}`).join("\n"));
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
async function cmdPublish(indexArg: string, dry: boolean): Promise<void> {
  if (!existsSync(DRAFTS)) throw new Error(`${DRAFTS} 가 없다. 먼저 generate 하세요`);

  const saved = JSON.parse(readFileSync(DRAFTS, "utf8")) as {
    topic: string;
    posts: ThreadsPost[];
  };
  const i = Number(indexArg);
  const post = saved.posts[i - 1];
  if (!post) throw new Error(`${i}번 글이 없다 (1~${saved.posts.length})`);

  const link = process.env["TRACKING_LINK"];
  const text = link
    ? injectTrackingLink(post.text, link, THREADS_MAX_CHARS).text
    : post.text;

  console.log(`\n올릴 글 (${text.length}자):\n`);
  console.log(text.split("\n").map((l) => `   ${l}`).join("\n"));
  console.log();

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
  console.log(`  permalink: ${r.permalink ?? "(조회 실패 — 프로필에서 확인하세요)"}\n`);

  rememberHook(post.hook_type);
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
const args = rest.filter((a) => !a.startsWith("--"));

try {
  if (cmd === "connect") await cmdConnect();
  else if (cmd === "generate") await cmdGenerate(args.join(" "));
  else if (cmd === "publish") await cmdPublish(args[0] ?? "", dry);
  else {
    console.log(`
사용법
  npm run cli -- connect              토큰 확인 · 쿼터 조회
  npm run cli -- generate "<주제>"     글 3종 생성 → 검증 → 저장
  npm run cli -- publish <번호>        실제 발행
  npm run cli -- publish <번호> --dry  발행 직전까지만
`);
  }
} catch (e) {
  console.error(`\n실패: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
