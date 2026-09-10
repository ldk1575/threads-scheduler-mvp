import { describe, expect, test } from "vitest";
import { keywordScreen } from "./safety.ts";

describe("keywordScreen — 낱말 안쪽 오탐", () => {
  // 뷰티 계정에서 피부 타입 + '인' 은 가장 자연스러운 표현이다.
  // 여기서 막히면 쓸 수 있는 문장이 통째로 사라진다.
  test.each([
    "다들 지성인데 오일 쓰는 사람 있어?",
    "건성인 사람들은 이거 조심해",
    "복합성인데 여름엔 답이 없더라",
    "민감성인 편이라 순한 걸로 골랐어",
  ])("%s → 통과한다", (text) => {
    const v = keywordScreen(text);
    expect(v.ai_use).toBe(true);
    expect(v.stage).toBe("passed");
  });

  test.each(["성인물 광고 문의", "이건 성인 콘텐츠다", "성인용품 협찬"])(
    "%s → 그대로 막는다",
    (text) => {
      const v = keywordScreen(text);
      expect(v.ai_use).toBe(false);
      expect(v.ai_skip_reason).toContain("성인");
    },
  );

  test("사유에는 규칙이 아니라 본문에서 걸린 말을 적는다", () => {
    const v = keywordScreen("성인 대상 도박 사이트");
    // 정규식 소스(/(?<![가-힣])성인/)가 새어 나오면 안 된다
    expect(v.ai_skip_reason).toBe("차단 키워드 포함: 성인");
  });

  test("문자열 키워드는 그대로 부분 문자열로 잡는다", () => {
    expect(keywordScreen("사설토토 홍보").ai_use).toBe(false);
    expect(keywordScreen("무직자 대출 가능").ai_use).toBe(false);
  });
});
