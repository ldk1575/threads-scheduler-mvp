/**
 * 2단 안전 필터 — ttj_threads_2026 의 구조를 가져왔다.
 *
 *   1단: 키워드 블랙리스트 (싸고 확실하다. AI 를 부르기 전에 거른다)
 *   2단: AI 적합성 판정 (use: true/false + 사유)
 *
 * ttj 는 이걸 "남의 글에 댓글을 달지 말지"에 썼다. 우리는 두 곳에 쓴다.
 *   - 내 글을 올릴지 (부적절한 소재로 브랜드를 태우지 않기)
 *   - 남의 글에 반응할지 (Phase 2)
 *
 * 판정 결과는 `ai_use` / `ai_skip_reason` 으로 남긴다.
 * 이 필드명은 ttj 의 result.json 과 같다 — 나중에 로그 스키마로 그대로 승계된다.
 */

import { extractJson, generate, type LlmDeps, type LlmOptions } from "../llm/provider.ts";

/** 기본 차단 키워드. 운영 중에 늘어나므로 설정으로 뺀다. */
export const DEFAULT_SPAM_KEYWORDS: readonly string[] = [
  "성인",
  "19금",
  "도박",
  "카지노",
  "대출",
  "코인리딩",
  "불법",
  "사설토토",
];

export type SafetyVerdict = {
  ai_use: boolean;
  ai_skip_reason: string | null;
  /** 어느 단계에서 걸렸나 */
  stage: "keyword" | "ai" | "passed";
};

/** 1단 — 키워드. AI 를 부르기 전에 끝낸다. */
export function keywordScreen(
  text: string,
  keywords: readonly string[] = DEFAULT_SPAM_KEYWORDS,
): SafetyVerdict {
  const lower = text.toLowerCase();
  for (const k of keywords) {
    if (lower.includes(k.toLowerCase())) {
      return {
        ai_use: false,
        ai_skip_reason: `차단 키워드 포함: ${k}`,
        stage: "keyword",
      };
    }
  }
  return { ai_use: true, ai_skip_reason: null, stage: "passed" };
}

const JUDGE_SYSTEM = [
  "너는 브랜드 계정의 콘텐츠 적합성을 판정한다.",
  "다음 중 하나라도 해당하면 use=false 로 판정한다.",
  "- 정치·종교·성적 내용, 특정 집단 비하",
  "- 의학적·재무적 단정(치료 효과 보장, 수익 보장)",
  "- 타인 비방, 분쟁 소지",
  "- 광고 티가 노골적이라 반감을 살 내용",
  '출력은 JSON 만: {"use": true|false, "reason": "한 줄 사유"}',
].join("\n");

/**
 * 2단 — AI 판정.
 *
 * ⚠️ AI 가 실패하면 **통과시키지 않고 막는다.** 판정을 못 했는데 올리는 것보다
 * 안 올리는 쪽이 싸다. 브랜드 계정은 한 번 잘못 올리면 되돌리기 어렵다.
 */
export async function aiScreen(
  text: string,
  llm: LlmOptions,
  deps: LlmDeps = {},
): Promise<SafetyVerdict> {
  try {
    const res = await generate(JUDGE_SYSTEM, `[검토할 글]\n${text}`, llm, deps);
    const parsed = extractJson<{ use?: boolean; reason?: string }>(res.text);

    if (parsed.use === true) {
      return { ai_use: true, ai_skip_reason: null, stage: "passed" };
    }
    return {
      ai_use: false,
      ai_skip_reason: parsed.reason ?? "AI 판정: 부적합",
      stage: "ai",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ai_use: false,
      ai_skip_reason: `AI 판정 실패로 보류: ${msg}`,
      stage: "ai",
    };
  }
}

/** 1단 → 2단 순서로 통과시킨다. 1단에서 걸리면 AI 를 부르지 않는다(비용·시간 절약). */
export async function screen(
  text: string,
  llm: LlmOptions,
  deps: LlmDeps = {},
  keywords: readonly string[] = DEFAULT_SPAM_KEYWORDS,
): Promise<SafetyVerdict> {
  const first = keywordScreen(text, keywords);
  if (!first.ai_use) return first;
  return aiScreen(text, llm, deps);
}
