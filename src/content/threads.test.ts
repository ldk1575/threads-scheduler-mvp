import { describe, expect, test } from "vitest";
import {
  HOOKS,
  pickHooks,
  buildThreadsPrompt,
  validatePosts,
  countChars,
  countEmoji,
  tooSimilar,
  type ThreadsPost,
} from "./threads.ts";

const PRODUCT = {
  title: "수분 진정 크림 50ml",
  salePrice: 19_900,
  listPrice: 29_000,
  sellingPoints: ["당김 없이 12시간", "무향·무색소", "임상 테스트 완료"],
  targetCustomer: "오후만 되면 피부가 당기는 30대 직장인",
  tone: "친구에게 카톡하듯",
  experience: "3개월 써본 실사용자",
};

function post(over: Partial<ThreadsPost> = {}): ThreadsPost {
  return {
    hook_type: "H4(질문)",
    structure: "질문폭격형",
    text:
      "오후만 되면 피부 당기지 않아요?\n\n" +
      "크림을 두껍게 바를 게 아니라 수분을 잡아두는 게 핵심이더라고요.\n" +
      "처음엔 저도 제형이 묵직한 걸 골랐는데, 바를 때만 촉촉하고 세 시간 지나면 똑같았어요.\n" +
      "순서를 바꿔 봤습니다. 씻고 나서 물기 남아 있을 때 얇게 한 겹, 그다음에 덮는 걸로요.\n" +
      "그러고 나서야 오후에 당기는 느낌이 줄었습니다.\n" +
      "양을 늘린 게 아니라 넣는 순서를 옮긴 것뿐인데 그렇게 됐어요.\n" +
      "돈 더 쓰기 전에 이것부터 해보셔도 될 것 같습니다.\n\n{{CTA_링크문구}}",
    char_count: 0,
    cta_kind: "프로필클릭",
    first_comment:
      "참고로 저는 겨울에만 이렇게 합니다.\n" +
      "여름엔 겹쳐 바르면 답답해서 오히려 한 겹으로 끝내요.\n" +
      "계절 따라 다르게 가는 게 맞더라고요. 같은 통인데 체감이 완전히 달라집니다.",
    ...over,
  };
}

// ───────────────────────────────────────────────
// 훅 라이브러리 — 00-공통 §2 를 코드가 들고 있어야 매번 지켜진다
// ───────────────────────────────────────────────
describe("훅 라이브러리", () => {
  test("H1~H10 열 종류가 모두 있다", () => {
    expect(HOOKS).toHaveLength(10);
    expect(HOOKS.map((h) => h.id)).toEqual([
      "H1", "H2", "H3", "H4", "H5", "H6", "H7", "H8", "H9", "H10",
    ]);
  });

  test("각 훅은 계열(family)을 갖는다 — 로테이션 규칙의 단위", () => {
    for (const h of HOOKS) {
      expect(["공감", "정보", "서사"]).toContain(h.family);
    }
  });
});

describe("훅 로테이션", () => {
  test("3개를 뽑고, 서로 다르다", () => {
    const picked = pickHooks([], 3);
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((h) => h.id)).size).toBe(3);
  });

  test("★ 최근에 쓴 훅은 피한다 — 같은 훅 반복이 계정 톤을 망친다", () => {
    const recent = ["H4", "H2", "H9", "H1", "H10"];
    const picked = pickHooks(recent, 3);
    for (const h of picked) expect(recent).not.toContain(h.id);
  });

  test("계열이 한쪽으로 쏠리지 않는다", () => {
    const picked = pickHooks([], 3);
    expect(new Set(picked.map((h) => h.family)).size).toBeGreaterThanOrEqual(2);
  });

  test("쓸 수 있는 훅이 모자라면 가장 오래 전에 쓴 것부터 다시 쓴다", () => {
    const recent = HOOKS.map((h) => h.id); // 전부 최근에 씀
    const picked = pickHooks(recent, 3);
    expect(picked).toHaveLength(3);
    expect(new Set(picked.map((h) => h.id)).size).toBe(3);
  });
});

// ───────────────────────────────────────────────
// 프롬프트 — 03-스레드.md 의 System/User 템플릿을 채운다
// ───────────────────────────────────────────────
describe("프롬프트 조립", () => {
  test("상품 메타와 톤이 주입된다", () => {
    const p = buildThreadsPrompt(PRODUCT, { recentHooks: [] });
    expect(p.system).toContain("친구에게 카톡하듯");
    expect(p.user).toContain("수분 진정 크림 50ml");
    expect(p.user).toContain("당김 없이 12시간");
  });

  test("뽑은 훅을 지정해 넣는다 — 모델이 고르게 두지 않는다", () => {
    const p = buildThreadsPrompt(PRODUCT, { recentHooks: [] });
    expect(p.hooks).toHaveLength(3);
    for (const h of p.hooks) expect(p.user).toContain(h.id);
  });

  test("절대 규칙이 프롬프트에 들어간다", () => {
    const p = buildThreadsPrompt(PRODUCT, { recentHooks: [] });
    expect(p.system).toContain("200~350자");
    expect(p.user).toContain("{{CTA_링크문구}}");
    expect(p.user).toContain("first_comment");
    expect(p.system).toMatch(/판매어|구매/);
  });
});

// ───────────────────────────────────────────────
// 검증 게이트 — 여기가 품질을 실제로 지키는 자리
// ───────────────────────────────────────────────
describe("검증 게이트", () => {
  test("정상 3종은 통과한다", () => {
    const r = validatePosts([
      post({ hook_type: "H4(질문)", structure: "질문폭격형" }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "고백경험담형" }),
    ]);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("3개가 아니면 거절", () => {
    expect(validatePosts([post()]).errors).toContain("글이 3개가 아니다 (1개)");
  });

  test("★ 훅 유형이 겹치면 거절 — 3종을 만드는 이유가 사라진다", () => {
    const r = validatePosts([
      post({ hook_type: "H4(질문)", structure: "질문폭격형" }),
      post({ hook_type: "H4(질문)", structure: "리스트형" }),
      post({ hook_type: "H2(숫자)", structure: "반전형" }),
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/훅 유형이 겹친다/);
  });

  test("구조 유형이 겹치면 거절", () => {
    const r = validatePosts([
      post({ hook_type: "H4(질문)", structure: "리스트형" }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "반전형" }),
    ]);
    expect(r.errors.join()).toMatch(/구조 유형이 겹친다/);
  });

  test("★ 직접 판매어는 거절 — 00-공통 §0.3", () => {
    const bad = ["지금 구매하세요", "최저가 보장", "100% 효과", "지금 신청하세요"];
    for (const phrase of bad) {
      const r = validatePosts([
        post({ text: `훅\n\n${phrase}\n\n{{CTA_링크문구}}` }),
        post({ hook_type: "H2(숫자)", structure: "리스트형" }),
        post({ hook_type: "H9(공감)", structure: "반전형" }),
      ]);
      expect(r.errors.join()).toMatch(/판매어|과장/);
    }
  });

  test("★ CTA 자리표시자가 없으면 거절 — 링크가 안 들어가면 추적이 끊긴다", () => {
    const r = validatePosts([
      post({ text: "훅\n\n본문만 있고 CTA 없음" }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "반전형" }),
    ]);
    expect(r.errors.join()).toMatch(/CTA_링크문구/);
  });

  test("실제 URL 이 박혀 있으면 거절 — 링크는 배포 시 주입한다", () => {
    const r = validatePosts([
      post({ text: "훅\n\nhttps://example.com 확인\n\n{{CTA_링크문구}}" }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "반전형" }),
    ]);
    expect(r.errors.join()).toMatch(/URL/);
  });

  test("350자를 넘으면 거절", () => {
    const r = validatePosts([
      post({ text: "가".repeat(400) + "\n{{CTA_링크문구}}" }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "반전형" }),
    ]);
    expect(r.errors.join()).toMatch(/350자를 넘는다/);
  });

  /**
   * 하한이 이 게이트의 핵심이다.
   *
   * 상한만 걸려 있던 동안 모델은 계속 100자 아래로 썼다 — 짧은 게 안전하니까.
   * 실제로 올라간 글 12개가 전부 "훅 + 한 문장 + 질문"이었다.
   */
  test("200자에 못 미치면 거절", () => {
    const r = validatePosts([
      post({ text: "오늘 이거 알았어요?\n\n별거 아니네요.\n\n{{CTA_링크문구}}" }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "반전형" }),
    ]);
    expect(r.errors.join()).toMatch(/200자에 못 미친다/);
  });

  test("first_comment 가 없으면 거절", () => {
    const r = validatePosts([
      post({ first_comment: "" }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "반전형" }),
    ]);
    expect(r.errors.join()).toMatch(/first_comment 가 없다/);
  });

  test("first_comment 가 짧으면 거절", () => {
    const r = validatePosts([
      post({ first_comment: "좋아요!" }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "반전형" }),
    ]);
    expect(r.errors.join()).toMatch(/첫 댓글이 80~250자를 벗어난다/);
  });

  /** 본문을 되풀이하는 댓글은 스크롤을 멈출 이유가 없다. */
  test("first_comment 가 본문과 겹치면 거절", () => {
    const base = post();
    const r = validatePosts([
      { ...base, first_comment: base.text.replace("{{CTA_링크문구}}", "").trim() },
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "반전형" }),
    ]);
    expect(r.errors.join()).toMatch(/첫 댓글이 본문과 너무 겹친다/);
  });

  test("cta_kind 는 세 종류만 허용", () => {
    const r = validatePosts([
      post({ cta_kind: "구매유도" as never }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "반전형" }),
    ]);
    expect(r.errors.join()).toMatch(/cta_kind/);
  });

  test("char_count 는 자동으로 실제 길이로 맞춰진다", () => {
    const r = validatePosts([
      post({ char_count: 999 }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "반전형" }),
    ]);
    expect(r.posts[0]!.char_count).toBe(r.posts[0]!.text.length);
  });

  // 경고 — 거절하진 않지만 사람이 봐야 하는 것
  test("훅이 반올림 숫자면 경고 — '약 3개월'보다 '87일'", () => {
    const r = validatePosts([
      post({ text: "약 3개월 써봤어요\n\n본문\n\n{{CTA_링크문구}}" }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "반전형" }),
    ]);
    expect(r.warnings.join()).toMatch(/반올림/);
  });

  test("훅에서 답을 줘버리면 경고 — 궁금증이 안 남는다", () => {
    const r = validatePosts([
      post({ text: "수분크림은 두껍게 바르면 됩니다\n\n본문\n\n{{CTA_링크문구}}" }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "반전형" }),
    ]);
    expect(r.warnings.join()).toMatch(/훅에서 답/);
  });
});

// ───────────────────────────────────────────────
// 반복 방지 — 같은 계정이 비슷한 글을 계속 올리면 도달이 떨어진다
// ───────────────────────────────────────────────
describe("경고 — 막지는 않고 사람이 보게 한다", () => {
  /** 훅만 갈아끼운 3종. 오류 없이 경고만 남게 만든다. */
  function three(firstLines: readonly string[]) {
    const kinds = [
      { hook_type: "H4(질문)", structure: "질문폭격형" },
      { hook_type: "H2(숫자)", structure: "리스트형" },
      { hook_type: "H9(공감)", structure: "고백경험담형" },
    ];
    return validatePosts(
      kinds.map((k, i) => {
        const base = post(k);
        const rest = base.text.split("\n").slice(1).join("\n");
        return { ...base, text: (firstLines[i] ?? firstLines[0] ?? "") + "\n" + rest };
      }),
    );
  }

  const OK_HOOK = "오후만 되면 피부 당기지 않아요?";

  test("훅이 35자를 넘으면 경고한다 — 미리보기에서 잘린다", () => {
    // 실제로 나왔던 37자 훅
    const long = "다들 지성 피부는 오일 쓰면 안 된다는데, 사실 완전 반대더라고요.";
    expect([...long].length).toBe(37);

    const r = three([long, OK_HOOK, OK_HOOK]);
    expect(r.warnings.some((w) => w.includes("훅이 35자를 넘는다 (37자)"))).toBe(true);
  });

  test("35자 이하면 조용하다", () => {
    const r = three([OK_HOOK, OK_HOOK, OK_HOOK]);
    expect(r.warnings.some((w) => w.includes("훅이 35자를 넘는다"))).toBe(false);
  });

  test.each(["모공이 서서히 줄어드는 게 눈에 보여", "3일 만에 피지가 없어짐", "각질이 싹 사라졌어"])(
    "효과 단정을 경고한다 — %s",
    (claim) => {
      const r = validatePosts([
        post({ hook_type: "H4(질문)", structure: "질문폭격형", text: post().text + "\n" + claim }),
        post({ hook_type: "H2(숫자)", structure: "리스트형" }),
        post({ hook_type: "H9(공감)", structure: "고백경험담형" }),
      ]);
      expect(r.warnings.some((w) => w.includes("효과 단정으로 읽힐 표현"))).toBe(true);
    },
  );

  test("첫 댓글의 단정도 잡는다 — 댓글에서도 똑같이 문제가 된다", () => {
    const r = validatePosts([
      post({
        hook_type: "H4(질문)",
        structure: "질문폭격형",
        first_comment: "이거 쓰고 모공이 줄어드는 게 보이더라고요. 순서만 바꿨을 뿐인데 그렇게 됐어요. 자세한 건 본문에 안 썼는데 저녁에만 쓰는 게 핵심이었어요.",
      }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "고백경험담형" }),
    ]);
    expect(r.warnings.some((w) => w.includes("효과 단정으로 읽힐 표현"))).toBe(true);
  });

  // '성인' 오탐에서 배운 것 — 넓힌 규칙은 반드시 반대편도 재 본다.
  test.each([
    "모공 넓어지기 전에 얼른 이 방법으로 갈아타자",
    "오히려 오일로 피지를 녹여야 모공이 깨끗해지더라고",
    "모공 고민 있는 지성 언니들 요즘 클렌징 뭐 써?",
    "이 오일 다 쓰는 데 3일 걸렸어",
  ])("멀쩡한 문장은 안 잡는다 — %s", (line) => {
    const r = validatePosts([
      post({ hook_type: "H4(질문)", structure: "질문폭격형", text: post().text + "\n" + line }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "고백경험담형" }),
    ]);
    expect(r.warnings.some((w) => w.includes("효과 단정"))).toBe(false);
  });

  test("경고는 통과를 막지 않는다", () => {
    const long = "다들 지성 피부는 오일 쓰면 안 된다는데, 사실 완전 반대더라고요.";
    const r = three([long, OK_HOOK, OK_HOOK]);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("이모지", () => {
  test("글자수를 코드포인트로 센다 — 💄 는 두 글자가 아니다", () => {
    const withEmoji = "🧴 클렌징 ✨";
    expect(withEmoji.length).toBe(8); // 자바스크립트가 세는 법
    expect(countChars(withEmoji)).toBe(7); // 사람이 세는 법
  });

  test("결합 이모지도 한 글자다", () => {
    expect("👩‍💻".length).toBe(5);
    expect(countChars("👩‍💻")).toBe(3); // ZWJ 결합 — 최소한 5는 아니다
  });

  test("이모지를 센다", () => {
    expect(countEmoji("🧴 클렌징 ✨ 진짜 💄")).toBe(3);
    expect(countEmoji("이모지 없는 글")).toBe(0);
  });

  test("이모지가 많으면 경고한다 — 장식이 내용을 가린다", () => {
    const many = "✨💄🧴💧🌿🫧🎀 오늘의 꿀템";
    const r = validatePosts([
      post({ hook_type: "H4(질문)", structure: "질문폭격형", text: post().text + "\n" + many }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "고백경험담형" }),
    ]);
    expect(r.warnings.some((w) => w.includes("이모지가"))).toBe(true);
    expect(r.errors).toEqual([]); // 막지는 않는다
  });

  test("적당히 쓰면 조용하다", () => {
    const r = validatePosts([
      post({ hook_type: "H4(질문)", structure: "질문폭격형", text: post().text + "\n✨ 오늘의 꿀템 💄" }),
      post({ hook_type: "H2(숫자)", structure: "리스트형" }),
      post({ hook_type: "H9(공감)", structure: "고백경험담형" }),
    ]);
    expect(r.warnings.some((w) => w.includes("이모지가"))).toBe(false);
  });

  test("프롬프트가 이모지 규칙을 싣는다", () => {
    const p = buildThreadsPrompt(PRODUCT, { recentHooks: [] });
    expect(p.user).toContain("이모지로 포인트를 짚는다");
    expect(p.user).toContain("훅에는 이모지를 최대 1개");
  });
});

describe("반복 방지", () => {
  test("단어가 절반 가까이 겹치면 너무 비슷하다고 본다", () => {
    const a = "오후만 되면 피부 당기지 않아요 크림을 두껍게 바를 게 아니라 수분을 잡아두는 게 핵심";
    const b = "오후만 되면 피부 당기죠 크림을 두껍게 바를 게 아니라 수분을 잡아두는 게 중요";
    expect(tooSimilar(a, [b])).toBe(true);
  });

  test("다른 주제면 통과한다", () => {
    const a = "오후만 되면 피부 당기지 않아요";
    const b = "겨울철 난방비 아끼는 방법 세 가지";
    expect(tooSimilar(a, [b])).toBe(false);
  });

  test("비교 대상이 없으면 항상 통과", () => {
    expect(tooSimilar("아무 글", [])).toBe(false);
  });
});
