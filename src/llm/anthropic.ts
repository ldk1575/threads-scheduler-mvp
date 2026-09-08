/**
 * Anthropic Messages API 백엔드.
 *
 * `claude-cli` 는 이 컴퓨터에 설치된 CLI 를 부르므로 서버에서는 못 쓴다.
 * 배포 환경에서는 이쪽을 쓴다.
 *
 * ⚠️ Opus 5 에서 바뀐 것 두 가지 (예전 코드를 그대로 옮기면 400 이 난다)
 *   - `temperature` / `top_p` / `top_k` 가 **제거**됐다. 보내면 400.
 *   - `thinking.budget_tokens` 도 **제거**됐다. 사고량은 `output_config.effort` 로 조절한다.
 */

import Anthropic from "@anthropic-ai/sdk";

/** 기본 모델. 사용자가 다른 걸 지정하지 않으면 이걸 쓴다. */
export const DEFAULT_MODEL = "claude-opus-5";

/**
 * 글 3종 생성처럼 짧고 정형화된 작업이라 `effort` 를 낮춰 둔다.
 * 사고 토큰도 max_tokens 에 포함되므로 넉넉히 잡는다 — 모자라면 JSON 이 중간에 잘린다.
 */
const MAX_TOKENS = 8192;
const EFFORT = "medium" as const;

export function makeAnthropicCaller(env: NodeJS.ProcessEnv = process.env) {
  return async (system: string, user: string): Promise<string> => {
    const apiKey = env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Error("E-LLM-401: ANTHROPIC_API_KEY 가 없다");

    const client = new Anthropic({ apiKey });

    const res = await client.messages.create({
      model: env["ANTHROPIC_MODEL"] ?? DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: EFFORT },
      system,
      messages: [{ role: "user", content: user }],
    });

    // 안전 분류기가 거절하면 200 으로 오되 stop_reason 이 refusal 이다.
    // content 를 읽기 전에 확인해야 한다.
    if (res.stop_reason === "refusal") {
      throw new Error(
        `E-LLM-451: 모델이 요청을 거절했다 (${res.stop_details?.category ?? "사유 없음"})`,
      );
    }

    // content 는 여러 블록의 배열이다. text 블록만 모은다.
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new Error(`E-LLM-502: 빈 응답 (stop_reason=${res.stop_reason})`);
    }
    return text;
  };
}
