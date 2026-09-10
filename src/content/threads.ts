/**
 * 스레드 게시글 생성 — 훅 라이브러리 · 프롬프트 조립 · 검증 게이트.
 *
 * 근거 문서(리포의 SSOT):
 *   docs/content/prompt-guides/00-공통-원칙과-후킹.md
 *   docs/content/prompt-guides/03-스레드.md
 *
 * 이 파일이 있는 이유 — 그 규칙들이 문서에만 있으면 매번 지켜지지 않는다.
 * 모델은 자주 어긴다. 그래서 **코드가 게이트를 잡는다.**
 */

// ───────────────────────────────────────────────────────────
// 훅 라이브러리 (00-공통 §2)
// ───────────────────────────────────────────────────────────

export type HookFamily = "공감" | "정보" | "서사";

export type Hook = {
  id: string;
  name: string;
  /** 로테이션의 단위. 00-공통 §2 "주간 예: 공감 2 + 정보 2 + 서사 2 + 자유 1" */
  family: HookFamily;
  /** 모델에게 주는 공식 */
  formula: string;
};

export const HOOKS: readonly Hook[] = [
  { id: "H1", name: "고민 직격형", family: "공감", formula: "타겟이 속으로 하는 말을 대신 말해준다" },
  { id: "H2", name: "숫자 충격형", family: "정보", formula: "구체 숫자·기간 + 의외의 결과" },
  { id: "H3", name: "상식 반전형", family: "정보", formula: "다들 [통념]이라는데, 사실 [반전]" },
  { id: "H4", name: "질문·자가진단형", family: "공감", formula: "혹시 [상황]인데 [증상]인가요?" },
  { id: "H5", name: "비밀·내부자형", family: "정보", formula: "[업계]에서 안 알려주는 [사실]" },
  { id: "H6", name: "손실회피·경고형", family: "서사", formula: "[행동] 계속하면 [손실]" },
  { id: "H7", name: "호기심 갭형", family: "서사", formula: "[결과]가 있었는데… 이유는 뒤에" },
  { id: "H8", name: "비교·대조형", family: "정보", formula: "[A] vs [B], 차이는 [핵심]" },
  { id: "H9", name: "공감·저격형", family: "공감", formula: "[타겟]이라면 다 겪는 [순간]" },
  { id: "H10", name: "리스트·저장유도형", family: "정보", formula: "[주제] [N]가지 (저장각)" },
] as const;

const CTA_KINDS = ["댓글유도", "프로필클릭", "저장유도"] as const;
export type CtaKind = (typeof CTA_KINDS)[number];

export const CTA_PLACEHOLDER = "{{CTA_링크문구}}";

/**
 * 본문 길이.
 *
 * 스레드 자체 상한은 500자다. 그보다 낮게 잡은 건 끝까지 읽히는 길이가 따로 있어서다.
 *
 * **하한이 진짜 장치다.** 상한만 걸어 두면 모델은 계속 짧게 쓴다 — 짧은 게 안전하니까.
 * 실제로 100자 상한만 있던 동안 올라간 글은 전부 "훅 + 한 문장 + 질문"이었고,
 * 구조 목록에 있는 고백경험담형·스토리텔링형이 들어갈 자리가 없었다.
 */
export const MIN_POST_CHARS = 200;
export const MAX_POST_CHARS = 350;

/**
 * 훅 길이 상한.
 *
 * 스레드 미리보기에서 잘리는 지점이다. 잘린 훅은 궁금증이 아니라 사고로 읽힌다.
 * 프롬프트에도 이 값을 넣어 쓴다 — 요구하는 값과 재는 값이 갈리면 안 된다.
 */
export const MAX_HOOK_CHARS = 35;

/** 첫 댓글 길이. 본문보다 짧아야 부연으로 읽힌다. */
export const MIN_COMMENT_CHARS = 80;
export const MAX_COMMENT_CHARS = 250;

/** 상품 글과 주제 글이 같은 문구를 쓴다. 한 군데서만 고치도록 여기 둔다. */
export const FIRST_COMMENT_RULES: readonly string[] = [
  `- first_comment: 본문 바로 아래 내가 달 첫 댓글. ${MIN_COMMENT_CHARS}~${MAX_COMMENT_CHARS}자.`,
  "  본문을 요약하거나 반복하지 마라. **본문에 안 쓴 구체적인 것 하나**를 담는다 —",
  "  실패했던 순간, 해보고 알게 된 디테일, 사람들이 자주 틀리는 지점 중 하나.",
  "  링크·URL 을 넣지 마라.",
];

/**
 * 훅을 고른다.
 *
 * 같은 훅을 반복하면 계정 톤이 무너지고 도달이 떨어진다(00-공통 §2 로테이션).
 * 그래서 최근에 쓴 것은 피하고, 계열이 한쪽으로 쏠리지 않게 섞는다.
 *
 * @param recentHooks 최근 쓴 훅 id. **최신이 앞**이다.
 */
export function pickHooks(recentHooks: readonly string[], n = 3): Hook[] {
  const recent = new Set(recentHooks);
  const fresh = HOOKS.filter((h) => !recent.has(h.id));

  const picked: Hook[] = [];
  const usedFamilies = new Set<HookFamily>();

  // 1순위 — 안 쓴 훅 중에서 계열이 겹치지 않게
  for (const h of fresh) {
    if (picked.length >= n) break;
    if (usedFamilies.has(h.family)) continue;
    picked.push(h);
    usedFamilies.add(h.family);
  }
  // 2순위 — 계열이 겹쳐도 안 쓴 훅으로 채운다
  for (const h of fresh) {
    if (picked.length >= n) break;
    if (picked.includes(h)) continue;
    picked.push(h);
  }
  // 3순위 — 다 썼으면 가장 오래 전에 쓴 것부터 다시 쓴다 (recentHooks 는 최신이 앞)
  for (let i = recentHooks.length - 1; i >= 0 && picked.length < n; i--) {
    const h = HOOKS.find((x) => x.id === recentHooks[i]);
    if (h && !picked.includes(h)) picked.push(h);
  }

  return picked.slice(0, n);
}

// ───────────────────────────────────────────────────────────
// 프롬프트 조립 (03-스레드.md)
// ───────────────────────────────────────────────────────────

export type ProductMeta = {
  title: string;
  salePrice: number;
  listPrice?: number;
  sellingPoints: string[];
  targetCustomer: string;
  tone: string;
  experience?: string;
  category?: string;
};

export type BuiltPrompt = {
  system: string;
  user: string;
  hooks: Hook[];
};

export function buildThreadsPrompt(
  product: ProductMeta,
  opts: { recentHooks: readonly string[] },
): BuiltPrompt {
  const hooks = pickHooks(opts.recentHooks, 3);

  const system = [
    "너는 스레드에서 숏폼 텍스트 콘텐츠를 만드는 전문가다.",
    `[내 정보] 타겟:${product.targetCustomer} / 말투:${product.tone}${product.experience ? ` / 경험:${product.experience}` : ""}`,
    `글은 스레드 기준 ${MIN_POST_CHARS}~${MAX_POST_CHARS}자(복사해 바로 올릴 완성본)로 만든다. 짧게 끝내지 마라.`,
    "전문용어 금지, 과장·단정 금지, 직접 판매어(구매/신청/최저가) 금지.",
    "첫 줄은 훅이다. 훅에서 답을 주지 마라 — 궁금증만 남기고 답은 본문에 둔다.",
    "숫자는 반올림하지 않는다. '약 3개월'이 아니라 '87일'처럼 쓴다.",
    "문장 길이를 일부러 고르게 만들지 마라. 너무 정돈되면 AI 티가 난다.",
    "출력은 JSON 스키마만 반환한다. 코드펜스·설명문 금지.",
  ].join("\n");

  const priceLine = product.listPrice
    ? `판매가 ${product.salePrice.toLocaleString()}원 (정상가 ${product.listPrice.toLocaleString()}원)`
    : `판매가 ${product.salePrice.toLocaleString()}원`;

  const user = [
    `[상품] ${product.title} / 셀링포인트 ${product.sellingPoints.join(", ")} / ${priceLine}`,
    "[요구]",
    "- 스레드 글 3개. 아래 지정된 훅을 하나씩 쓴다. 구조 유형도 서로 달라야 한다.",
    ...hooks.map((h, i) => `  ${i + 1}) ${h.id} ${h.name} — ${h.formula}`),
    "- 구조 유형은 다음에서 고른다: 고백경험담형 / 리스트형 / 반전형 / 비교형 / 질문폭격형 / 한줄반복형 / 스토리텔링형 / 대댓글유도형",
    `- 각 글: 첫 줄 훅(${MAX_HOOK_CHARS}자 이내) + 본문 + 마지막 줄 CTA. 전체 ${MIN_POST_CHARS}~${MAX_POST_CHARS}자.`,
    "- 본문은 한 문장으로 끝내지 마라. 장면·과정·바뀐 점 중 하나는 반드시 들어간다.",
    `- CTA 문구는 반드시 ${CTA_PLACEHOLDER} 자리표시자로 둔다. 실제 URL 을 쓰지 마라.`,
    `- cta_kind 는 ${CTA_KINDS.join(" / ")} 중 하나.`,
    ...FIRST_COMMENT_RULES,
    '- 출력: {"posts":[{"hook_type","structure","text","char_count","cta_kind","first_comment"}]}',
  ].join("\n");

  return { system, user, hooks };
}

// ───────────────────────────────────────────────────────────
// 검증 게이트
// ───────────────────────────────────────────────────────────

export type ThreadsPost = {
  hook_type: string;
  structure: string;
  text: string;
  char_count: number;
  cta_kind: CtaKind;
  /**
   * 본문 바로 아래 내가 다는 첫 댓글.
   *
   * 본문에서 못 한 구체적인 이야기 하나를 담는다. 요약이 아니다 —
   * 요약이면 스크롤을 멈출 이유가 없다. 그래서 본문과 겹치면 거절한다.
   */
  first_comment: string;
};

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  /** 거절하진 않지만 사람이 봐야 하는 것 */
  warnings: string[];
  posts: ThreadsPost[];
};

/** 00-공통 §0.3 — 직접 판매·과장·허위 */
const BANNED = [
  /지금\s*구매/,
  /구매\s*하세요/,
  /신청\s*하세요/,
  /최저가/,
  /100\s*%/,
  /완치/,
  /효과\s*보장/,
];

/**
 * 화장품 효능 단정.
 *
 * 개인 후기 형식이어도 "쓰면 이렇게 된다"로 읽히면 위험하다. 다만 진짜 겪은
 * 일일 수도 있어서 **경고로만 띄운다** — 막지 않고 사람이 보게 한다.
 *
 * 좁게 잡는다. '성인' 오탐에서 봤듯이 넓은 규칙은 멀쩡한 글을 잡아먹는다.
 * 실제 출력에서 나온 것만 넣었다.
 */
const EFFECT_CLAIM_RE: readonly RegExp[] = [
  // 사이에 부사가 낀다 — "모공이 **서서히** 줄어드는". 다만 한글·공백만,
  // 그것도 몇 글자까지만 허용한다. 문장을 건너뛰며 잡으면 오탐이 된다.
  /모공[이가]?[가-힣\s]{0,6}(줄어|작아|축소)/,
  /(싹|완전히|말끔히)[가-힣\s]{0,4}(사라|없어)/,
  /\d+\s*일\s*만에/,
];

const URL_RE = /https?:\/\/\S+/;
const ROUNDED_RE = /(약|대략|한)\s*\d+\s*(개월|년|일|주|시간|분|명|개)/;
/** 첫 줄이 단정 종결로 끝나면 훅이 답을 줘버린 것 */
const CONCLUSIVE_RE = /(습니다|입니다|됩니다|하세요|이다)\s*[.!]?$/;

function hookId(hookType: string): string {
  return /^H\d+/.exec(hookType)?.[0] ?? hookType;
}

export function validatePosts(raw: readonly ThreadsPost[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // char_count 는 모델을 믿지 않고 코드가 다시 센다
  const posts: ThreadsPost[] = raw.map((p) => ({ ...p, char_count: p.text.length }));

  if (posts.length !== 3) {
    errors.push(`글이 3개가 아니다 (${posts.length}개)`);
  }

  const hookIds = posts.map((p) => hookId(p.hook_type));
  if (new Set(hookIds).size !== hookIds.length) {
    errors.push(`훅 유형이 겹친다: ${hookIds.join(", ")}`);
  }

  const structures = posts.map((p) => p.structure);
  if (new Set(structures).size !== structures.length) {
    errors.push(`구조 유형이 겹친다: ${structures.join(", ")}`);
  }

  posts.forEach((p, i) => {
    const n = i + 1;
    const firstLine = p.text.split("\n")[0]?.trim() ?? "";

    for (const re of BANNED) {
      if (re.test(p.text)) {
        errors.push(`${n}번 글에 직접 판매어·과장 표현이 있다 (${re.source})`);
        break;
      }
    }

    if (!p.text.includes(CTA_PLACEHOLDER)) {
      errors.push(`${n}번 글에 ${CTA_PLACEHOLDER} 자리표시자가 없다 — 링크가 안 들어가면 클릭 추적이 끊긴다`);
    }

    if (URL_RE.test(p.text)) {
      errors.push(`${n}번 글에 실제 URL 이 있다 — 링크는 배포 시 주입한다`);
    }

    if (p.char_count > MAX_POST_CHARS) {
      errors.push(`${n}번 글이 ${MAX_POST_CHARS}자를 넘는다 (${p.char_count}자)`);
    }

    if (p.char_count < MIN_POST_CHARS) {
      errors.push(
        `${n}번 글이 ${MIN_POST_CHARS}자에 못 미친다 (${p.char_count}자) — 훅과 질문만 있고 이야기가 없다`,
      );
    }

    // ── 첫 댓글 ────────────────────────────────────────────
    const c = (p.first_comment ?? "").trim();
    if (!c) {
      errors.push(`${n}번 글에 first_comment 가 없다`);
    } else {
      if (c.length < MIN_COMMENT_CHARS || c.length > MAX_COMMENT_CHARS) {
        errors.push(
          `${n}번 글의 첫 댓글이 ${MIN_COMMENT_CHARS}~${MAX_COMMENT_CHARS}자를 벗어난다 (${c.length}자)`,
        );
      }
      // 본문을 되풀이하는 댓글은 달 이유가 없다.
      if (tooSimilar(c, [p.text])) {
        errors.push(`${n}번 글의 첫 댓글이 본문과 너무 겹친다 — 본문에 없던 이야기를 담아야 한다`);
      }
      if (URL_RE.test(c)) {
        errors.push(`${n}번 글의 첫 댓글에 실제 URL 이 있다 — 링크는 배포 시 주입한다`);
      }
    }

    if (!CTA_KINDS.includes(p.cta_kind)) {
      errors.push(`${n}번 글의 cta_kind 가 허용값이 아니다 (${String(p.cta_kind)})`);
    }

    if ([...firstLine].length > MAX_HOOK_CHARS) {
      warnings.push(
        `${n}번 글의 훅이 ${MAX_HOOK_CHARS}자를 넘는다 (${[...firstLine].length}자) — 스레드 미리보기에서 잘린다`,
      );
    }

    // 본문과 첫 댓글을 함께 본다. 단정은 댓글에서도 똑같이 문제가 된다.
    for (const re of EFFECT_CLAIM_RE) {
      const hit = re.exec(p.text) ?? re.exec(p.first_comment ?? "");
      if (hit) {
        warnings.push(
          `${n}번 글에 효과 단정으로 읽힐 표현이 있다 ("${hit[0]}") — 겪은 일이어도 단정으로 읽히면 위험하다`,
        );
        break;
      }
    }

    if (ROUNDED_RE.test(firstLine)) {
      warnings.push(`${n}번 글의 훅이 반올림 숫자를 쓴다 — 정밀한 숫자가 더 멈추게 한다`);
    }

    if (!firstLine.includes("?") && CONCLUSIVE_RE.test(firstLine)) {
      warnings.push(`${n}번 글은 훅에서 답을 줘버린다 — 궁금증이 안 남는다`);
    }
  });

  return { ok: errors.length === 0, errors, warnings, posts };
}

// ───────────────────────────────────────────────────────────
// 반복 방지
// ───────────────────────────────────────────────────────────

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

/**
 * 최근 글과 너무 비슷하면 다시 쓰게 한다.
 *
 * 임베딩 없이 단어 교집합 비율로 판정한다. 가볍고 즉시 돈다.
 * 같은 계정이 비슷한 글을 반복하면 도달이 떨어진다.
 */
export function tooSimilar(text: string, recent: readonly string[], threshold = 0.45): boolean {
  const a = tokens(text);
  if (a.size === 0) return false;

  for (const r of recent) {
    const b = tokens(r);
    if (b.size === 0) continue;
    let hit = 0;
    for (const w of a) if (b.has(w)) hit += 1;
    if (hit / a.size >= threshold) return true;
  }
  return false;
}
