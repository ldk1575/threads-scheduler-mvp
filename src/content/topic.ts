/**
 * 주제 기반 글 생성.
 *
 * `threads.ts` 의 상품용 프롬프트와 규칙은 같다 — 훅을 지정하고, 100자 안에서,
 * 직접 판매어 없이, 첫 줄에서 답을 주지 않는다.
 * 다른 점은 가격·셀링포인트가 없고, **링크를 안 넣을 수도** 있다는 것뿐이다.
 */

import {
  CTA_PLACEHOLDER,
  MAX_POST_CHARS,
  pickHooks,
  validatePosts,
  type BuiltPrompt,
  type ThreadsPost,
  type ValidationResult,
} from "./threads.ts";

export type TopicMeta = {
  /** 무엇에 대해 쓰나 */
  topic: string;
  /** 누구에게 말하나 */
  audience: string;
  tone: string;
  /** 내 경험. 있으면 글이 확 살아난다 */
  experience?: string;
  /** 링크 유도를 넣을지. 기본 false */
  withLink?: boolean;
};

const CTA_KINDS = ["댓글유도", "프로필클릭", "저장유도"] as const;

export function buildTopicPrompt(
  meta: TopicMeta,
  opts: { recentHooks: readonly string[] },
): BuiltPrompt {
  const hooks = pickHooks(opts.recentHooks, 3);

  const system = [
    "너는 스레드에서 숏폼 텍스트 콘텐츠를 만드는 전문가다.",
    `[내 정보] 타겟:${meta.audience} / 말투:${meta.tone}` +
      (meta.experience ? ` / 경험:${meta.experience}` : ""),
    `글은 항상 스레드 숏폼 기준(${MAX_POST_CHARS}자 이내, 복사해 바로 올릴 완성본)으로 만든다.`,
    "전문용어 금지, 과장·단정 금지, 직접 판매어(구매/신청/최저가) 금지.",
    "첫 줄은 훅이다. 훅에서 답을 주지 마라 — 궁금증만 남기고 답은 본문에 둔다.",
    "아는 숫자는 반올림하지 않는다. '약 3개월'이 아니라 '87일'처럼 쓴다.",
    "다만 모르는 숫자는 **지어내지 마라.** 출처 없는 수치('13초 만에', '87%가')는 쓰지 않는다. 확실하지 않으면 숫자 없이 쓴다.",
    "문장 길이를 일부러 고르게 만들지 마라. 너무 정돈되면 AI 티가 난다.",
    "겪지 않은 일을 겪은 것처럼 쓰지 마라. 모르면 일반론으로 쓴다.",
    "출력은 JSON 스키마만 반환한다. 코드펜스·설명문 금지.",
  ].join("\n");

  const ctaLine = meta.withLink
    ? `- 마지막 줄은 ${CTA_PLACEHOLDER} 자리표시자로 둔다. 실제 URL 을 쓰지 마라.`
    : "- 링크를 넣지 마라. 마지막 줄은 댓글·저장을 부르는 한마디로 닫는다.";

  const user = [
    `[주제] ${meta.topic}`,
    "[요구]",
    "- 스레드 글 3개. 아래 지정된 훅을 하나씩 쓴다. 구조 유형도 서로 달라야 한다.",
    ...hooks.map((h, i) => `  ${i + 1}) ${h.id} ${h.name} — ${h.formula}`),
    "- 구조 유형은 다음에서 고른다: 고백경험담형 / 리스트형 / 반전형 / 비교형 / 질문폭격형 / 한줄반복형 / 스토리텔링형 / 대댓글유도형",
    `- 각 글: 첫 줄 훅(35자 이내) + 본문 + 마지막 줄 마무리. 전체 ${MAX_POST_CHARS}자 이내.`,
    ctaLine,
    `- cta_kind 는 ${CTA_KINDS.join(" / ")} 중 하나.`,
    '- 출력: {"posts":[{"hook_type","structure","text","char_count","cta_kind"}]}',
  ].join("\n");

  return { system, user, hooks };
}

/**
 * 주제 글 검증.
 *
 * 상품 글과 규칙이 같되, 링크를 안 쓰는 글이면 CTA 자리표시자를 요구하지 않는다.
 * 그 외(훅·구조 중복, 판매어, 100자, 실제 URL)는 그대로 적용된다.
 */
export function validateTopicPosts(
  raw: readonly ThreadsPost[],
  withLink = false,
): ValidationResult {
  const base = validatePosts(raw);
  if (withLink) return base;

  // 링크를 안 쓰는 글이므로 "CTA 자리표시자 없음" 만 걷어낸다.
  const errors = base.errors.filter((e) => !e.includes(CTA_PLACEHOLDER));
  return { ...base, errors, ok: errors.length === 0 };
}
