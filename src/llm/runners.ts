/**
 * LLM 백엔드의 실제 구현.
 *
 * `provider.ts` 는 실행기를 주입받는다(테스트에서 진짜 호출을 안 하려고).
 * 여기가 그 주입할 물건이다.
 *
 *   makeCliRunner  설치된 CLI 를 비대화형으로 부른다
 *   makeApiCaller  Gemini / OpenAI 를 HTTP 로 부른다
 */

import { spawn } from "node:child_process";
import type { CallApi, CliSpec, ProviderId, RunCli } from "./provider.ts";
import { makeAnthropicCaller } from "./anthropic.ts";

/**
 * CLI 를 1회 호출한다.
 *
 * ⚠️ 프롬프트를 인자가 아니라 **stdin** 으로 넘긴다.
 *    긴 인자·따옴표·줄바꿈이 윈도우에서 깨지기 때문이다.
 *
 * ⚠️ 윈도우에서는 `shell: true` 가 필요하다.
 *    `claude`·`gemini` 는 `.cmd` 심으로 설치돼 있어 그냥 spawn 하면 ENOENT 가 난다.
 */
export function makeCliRunner(opts: { timeoutMs?: number } = {}): RunCli {
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return (spec: CliSpec, prompt: string) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(spec.cmd, spec.args, {
        shell: process.platform === "win32",
        windowsHide: true,
      });

      let out = "";
      let err = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`E-LLM-504: ${spec.cmd} 가 ${timeoutMs}ms 안에 답하지 않았다`));
      }, timeoutMs);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (err += String(d)));

      child.on("error", (e) =>
        finish(() =>
          reject(
            new Error(
              `E-LLM-500: ${spec.cmd} 실행 실패 — ${e.message}. 설치돼 있고 PATH 에 있는지 확인하세요`,
            ),
          ),
        ),
      );

      child.on("close", (code) =>
        finish(() => {
          if (code === 0) return resolve(out.trim());
          reject(
            new Error(
              `E-LLM-502: ${spec.cmd} 가 코드 ${code} 로 끝났다 — ${err.trim().slice(0, 300)}`,
            ),
          );
        }),
      );

      child.stdin.write(prompt);
      child.stdin.end();
    });
}

/** API 백엔드. 키는 환경변수에서 읽는다. */
export function makeApiCaller(env: NodeJS.ProcessEnv = process.env): CallApi {
  const anthropic = makeAnthropicCaller(env);

  return async (provider: ProviderId, system: string, user: string): Promise<string> => {
    if (provider === "claude-api") return anthropic(system, user);

    if (provider === "gemini-api") {
      const key = env["GEMINI_API_KEY"];
      if (!key) throw new Error("E-LLM-401: GEMINI_API_KEY 가 없다");
      const model = env["GEMINI_MODEL"] ?? "gemini-3.5-flash";

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            // 사고(thinking) 토큰도 이 예산을 먹는다. 작게 잡으면
            // 본문이 조각만 남아 JSON 이 깨진다 — 실제로 77자짜리 파편을 받았다.
            max_tokens: 8192,
            temperature: 0.8,
            // 부탁이 아니라 강제. 프롬프트로만 시키면 산문을 쓴다.
            response_format: { type: "json_object" },
          }),
        },
      );
      if (!res.ok) {
        throw new Error(`E-LLM-${res.status}: Gemini — ${(await res.text()).slice(0, 300)}`);
      }
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return j.choices?.[0]?.message?.content ?? "";
    }

    if (provider === "openai-api") {
      const key = env["OPENAI_API_KEY"];
      if (!key) throw new Error("E-LLM-401: OPENAI_API_KEY 가 없다");
      const model = env["OPENAI_MODEL"] ?? "gpt-4o-mini";

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          // 최신 모델은 max_tokens 대신 이 이름을 받는다
          max_completion_tokens: 8192,
          response_format: { type: "json_object" },
        }),
      });
      if (!res.ok) {
        throw new Error(`E-LLM-${res.status}: OpenAI — ${(await res.text()).slice(0, 300)}`);
      }
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return j.choices?.[0]?.message?.content ?? "";
    }

    throw new Error(`E-LLM-400: API 백엔드가 아니다 (${provider})`);
  };
}

/** 환경변수에서 primary/secondary 를 읽는다. 기본은 설치된 CLI(추가 비용 없음). */
export function readLlmOptions(env: NodeJS.ProcessEnv = process.env): {
  primary: ProviderId;
  secondary?: ProviderId;
} {
  const primary = (env["LLM_PRIMARY"] ?? "claude-cli") as ProviderId;
  const secondary = env["LLM_SECONDARY"] as ProviderId | undefined;
  return secondary ? { primary, secondary } : { primary };
}
