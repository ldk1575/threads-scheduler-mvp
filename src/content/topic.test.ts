import { describe, expect, test } from "vitest";
import { buildTopicPrompt } from "./topic.ts";

const META = {
  topic: "요즘 다시 쓰기 시작한 클렌징오일",
  audience: "가성비를 따지는 2030",
  tone: "친구에게 카톡하듯",
};

const NO_HOOKS: readonly string[] = [];

describe("buildTopicPrompt — 지어낸 이력 막기", () => {
  test("경험을 [내 정보] 한 줄에 끼워 넣지 않고 따로 세운다", () => {
    const p = buildTopicPrompt({ ...META, experience: "이제 막 기록을 시작했다" }, { recentHooks: NO_HOOKS });

    expect(p.system).toContain("[경험] 이제 막 기록을 시작했다");
    // 한 줄에 붙이면 모델이 '분위기'로 읽고 없는 이력을 채운다
    expect(p.system).not.toContain("/ 경험:");
  });

  test("경험이 있으면 그 밖의 이력을 만들지 말라고 못박는다", () => {
    const p = buildTopicPrompt({ ...META, experience: "이제 막 기록을 시작했다" }, { recentHooks: NO_HOOKS });

    expect(p.system).toContain("[경험] 에 적힌 것이 내가 가진 전부다");
    expect(p.system).toContain("고등학생 때부터");
  });

  test("경험이 없으면 1인칭 경험담 자체를 막는다", () => {
    const p = buildTopicPrompt(META, { recentHooks: NO_HOOKS });

    expect(p.system).toContain("1인칭 경험담을 지어내지 말고 일반론으로 쓴다");
    expect(p.system).not.toContain("[경험]");
  });

  test("글 3개의 화자가 같은 사람임을 요구한다", () => {
    const p = buildTopicPrompt(META, { recentHooks: NO_HOOKS });

    // 피부 타입이 글마다 갈리면 같은 계정이 아닌 게 들통난다
    expect(p.system).toContain("같은 사람이다");
  });

  test("계정 정체성은 그대로 실린다", () => {
    const p = buildTopicPrompt({ ...META, category: "뷰티 기록 계정" }, { recentHooks: NO_HOOKS });

    expect(p.system).toContain('이 계정은 "뷰티 기록 계정" 계정이다');
  });
});
