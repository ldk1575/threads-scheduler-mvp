import { describe, expect, test } from "vitest";
import {
  CLI_SPECS,
  extractJson,
  generate,
  isCliBackend,
  type ProviderId,
} from "./provider.ts";
import { keywordScreen, aiScreen, screen } from "../content/safety.ts";

describe("CLI/API 백엔드 판별", () => {
  test("CLI 백엔드를 식별한다", () => {
    expect(isCliBackend("gemini-cli")).toBe(true);
    expect(isCliBackend("codex-cli")).toBe(true);
    expect(isCliBackend("claude-cli")).toBe(true);
  });

  test("API 백엔드를 식별한다", () => {
    expect(isCliBackend("gemini-api")).toBe(false);
    expect(isCliBackend("openai-api")).toBe(false);
  });

  test("CLI 는 비대화형 1회 호출 옵션을 갖는다", () => {
    expect(CLI_SPECS["claude-cli"]).toEqual({
      cmd: "claude",
      args: ["-p", "--output-format", "text"],
    });
    expect(CLI_SPECS["gemini-cli"]!.cmd).toBe("gemini");
    expect(CLI_SPECS["codex-cli"]!.cmd).toBe("codex");
  });
});

describe("폴백", () => {
  test("primary 가 되면 그대로 쓴다", async () => {
    const r = await generate("sys", "usr", { primary: "claude-cli" }, {
      runCli: async () => "응답",
    });
    expect(r).toEqual({
      text: "응답",
      usedProvider: "claude-cli",
      fellBack: false,
      viaCli: true,
    });
  });

  test("★ primary 가 죽으면 secondary 로 넘어간다", async () => {
    const tried: ProviderId[] = [];
    const r = await generate(
      "sys",
      "usr",
      { primary: "gemini-cli", secondary: "openai-api" },
      {
        runCli: async () => {
          tried.push("gemini-cli");
          throw new Error("토큰 소진");
        },
        callApi: async (p) => {
          tried.push(p);
          return "폴백 응답";
        },
      },
    );

    expect(tried).toEqual(["gemini-cli", "openai-api"]);
    expect(r.fellBack).toBe(true);
    expect(r.usedProvider).toBe("openai-api");
    expect(r.viaCli).toBe(false); // 폴백은 API 백엔드였음을 기록한다
  });

  test("빈 응답도 실패로 본다", async () => {
    const r = await generate(
      "sys",
      "usr",
      { primary: "claude-cli", secondary: "gemini-api" },
      { runCli: async () => "   ", callApi: async () => "실제 응답" },
    );
    expect(r.fellBack).toBe(true);
  });

  test("secondary 가 없으면 그냥 던진다", async () => {
    await expect(
      generate("s", "u", { primary: "claude-cli" }, {
        runCli: async () => { throw new Error("죽음"); },
      }),
    ).rejects.toThrow(/죽음/);
  });

  test("프롬프트는 stdin 으로 넘어간다 — 윈도우에서 인자가 깨지기 때문", async () => {
    let got = "";
    await generate("SYS", "USR", { primary: "claude-cli" }, {
      runCli: async (_spec, prompt) => { got = prompt; return "ok"; },
    });
    expect(got).toContain("SYS");
    expect(got).toContain("USR");
  });
});

describe("JSON 추출", () => {
  test("코드펜스를 벗긴다", () => {
    expect(extractJson('```json\n{"use":true}\n```')).toEqual({ use: true });
  });

  test("앞뒤 설명문이 붙어도 꺼낸다", () => {
    expect(extractJson('네, 판정했습니다.\n{"use":false,"reason":"정치"}\n감사합니다'))
      .toEqual({ use: false, reason: "정치" });
  });

  test("배열도 된다", () => {
    expect(extractJson('```\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  });

  test("JSON 이 없으면 던진다", () => {
    expect(() => extractJson("그냥 문장입니다")).toThrow(/E-LLM-422/);
  });
});

describe("2단 안전 필터", () => {
  test("1단 — 차단 키워드에서 걸린다", () => {
    const v = keywordScreen("이건 도박 관련 글입니다");
    expect(v.ai_use).toBe(false);
    expect(v.stage).toBe("keyword");
    expect(v.ai_skip_reason).toContain("도박");
  });

  test("1단 통과는 판정을 미룬다", () => {
    expect(keywordScreen("수분크림 후기").ai_use).toBe(true);
  });

  test("2단 — AI 가 부적합으로 보면 막는다", async () => {
    const v = await aiScreen("정치 얘기", { primary: "claude-cli" }, {
      runCli: async () => '{"use":false,"reason":"정치적 내용"}',
    });
    expect(v.ai_use).toBe(false);
    expect(v.ai_skip_reason).toBe("정치적 내용");
    expect(v.stage).toBe("ai");
  });

  test("★ AI 판정이 실패하면 통과시키지 않고 막는다 — 모르면 안 올린다", async () => {
    const v = await aiScreen("평범한 글", { primary: "claude-cli" }, {
      runCli: async () => { throw new Error("서버 오류"); },
    });
    expect(v.ai_use).toBe(false);
    expect(v.ai_skip_reason).toContain("보류");
  });

  test("1단에서 걸리면 AI 를 부르지 않는다 — 비용·시간 절약", async () => {
    let called = false;
    const v = await screen("카지노 후기", { primary: "claude-cli" }, {
      runCli: async () => { called = true; return '{"use":true}'; },
    });
    expect(v.stage).toBe("keyword");
    expect(called).toBe(false);
  });

  test("둘 다 통과하면 올릴 수 있다", async () => {
    const v = await screen("수분크림 후기", { primary: "claude-cli" }, {
      runCli: async () => '{"use":true}',
    });
    expect(v).toEqual({ ai_use: true, ai_skip_reason: null, stage: "passed" });
  });
});
