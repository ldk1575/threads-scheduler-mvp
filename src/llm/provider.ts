/**
 * LLM 멀티 백엔드 + 폴백.
 *
 * ttj_threads_2026(run.js)에서 가져온 구조다. 백엔드를 갈아끼울 수 있게 감싼 것이다.
 * 로컬 개발에서는 설치된 CLI 를 비대화형(one-shot)으로 호출하고,
 * 배포 환경에서는 API 백엔드를 쓴다. 어느 쪽이든 같은 인터페이스로 감싼다.
 *
 * 그리고 AI 는 언제든 죽는다(서버 불안정·토큰 소진). 그래서 폴백을 전제로 설계한다.
 *   primary 실패 → secondary 시도 → 둘 다 실패하면 호출자가 스텁으로 간다.
 *
 * 프로세스 실행은 주입받는다. 테스트에서 진짜 CLI 를 부르지 않기 위해서다.
 */

export type ProviderId =
  | "gemini-cli"
  | "codex-cli"
  | "claude-cli"
  | "gemini-api"
  | "openai-api";

/** 로컬 개발용 CLI 백엔드. 배포 환경에서는 API 백엔드를 쓴다. */
export const CLI_PROVIDERS: readonly ProviderId[] = [
  "gemini-cli",
  "codex-cli",
  "claude-cli",
];

export function isCliBackend(p: ProviderId): boolean {
  return CLI_PROVIDERS.includes(p);
}

/** 비대화형 1회 호출 명령. 프롬프트는 인자가 아니라 stdin 으로 넘긴다. */
export type CliSpec = { cmd: string; args: string[] };

/**
 * ⚠️ 프롬프트를 인자로 넘기지 않고 stdin 으로 넘기는 이유 —
 * 윈도우에서 긴 인자·따옴표가 깨진다(ttj 의 CLAUDE.md 가 같은 문제를 기록해 뒀다).
 */
export const CLI_SPECS: Record<string, CliSpec> = {
  "gemini-cli": { cmd: "gemini", args: ["-p"] },
  "codex-cli": { cmd: "codex", args: ["exec", "-"] },
  "claude-cli": { cmd: "claude", args: ["-p", "--output-format", "text"] },
};

export type RunCli = (spec: CliSpec, prompt: string) => Promise<string>;
export type CallApi = (provider: ProviderId, system: string, user: string) => Promise<string>;

export type LlmDeps = {
  runCli?: RunCli;
  callApi?: CallApi;
  log?: (line: string) => void;
};

export type LlmOptions = {
  primary: ProviderId;
  /** primary 가 실패하면 이걸로 다시 시도한다. 없으면 폴백하지 않는다. */
  secondary?: ProviderId;
};

export type LlmResult = {
  text: string;
  /** 실제로 응답을 준 백엔드 */
  usedProvider: ProviderId;
  /** primary 가 실패해 폴백했는지 */
  fellBack: boolean;
  /** CLI 백엔드로 처리됐는지 */
  viaCli: boolean;
};

async function callOne(
  provider: ProviderId,
  system: string,
  user: string,
  deps: LlmDeps,
): Promise<string> {
  const spec = CLI_SPECS[provider];
  if (spec) {
    if (!deps.runCli) throw new Error("E-LLM-500: CLI 실행기가 주입되지 않았다");
    // CLI 는 system/user 구분이 없다. 한 덩이로 합쳐 넘긴다.
    return deps.runCli(spec, `${system}\n\n---\n\n${user}`);
  }
  if (!deps.callApi) throw new Error("E-LLM-500: API 호출기가 주입되지 않았다");
  return deps.callApi(provider, system, user);
}

/**
 * 응답을 받는다. primary 가 실패하면 secondary 로 한 번 더 시도한다.
 *
 * @throws 둘 다 실패하면 마지막 오류를 던진다. 호출자는 스텁으로 폴백한다.
 */
export async function generate(
  system: string,
  user: string,
  opts: LlmOptions,
  deps: LlmDeps = {},
): Promise<LlmResult> {
  const log = deps.log ?? (() => {});

  try {
    const text = await callOne(opts.primary, system, user, deps);
    if (!text.trim()) throw new Error("빈 응답");
    return {
      text,
      usedProvider: opts.primary,
      fellBack: false,
      viaCli: isCliBackend(opts.primary),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[llm] ${opts.primary} 실패: ${msg}`);

    if (!opts.secondary) throw e;

    const text = await callOne(opts.secondary, system, user, deps);
    if (!text.trim()) throw new Error("E-LLM-502: 폴백도 빈 응답을 줬다");
    log(`[llm] ${opts.secondary} 로 폴백 성공`);
    return {
      text,
      usedProvider: opts.secondary,
      fellBack: true,
      viaCli: isCliBackend(opts.secondary),
    };
  }
}

/**
 * 모델 응답에서 JSON 만 안전하게 꺼낸다.
 *
 * CLI 든 API 든 코드펜스를 붙이거나 앞뒤에 설명을 다는 일이 잦다.
 * "JSON 만 반환하라"고 시켜도 지키지 않는다. 그래서 코드가 꺼낸다.
 */
export function extractJson<T = unknown>(raw: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced?.[1] ?? raw;

  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error("E-LLM-422: 응답에 JSON 이 없다");

  const opener = candidate[start];
  const closer = opener === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(closer);
  if (end <= start) throw new Error("E-LLM-422: JSON 이 닫히지 않았다");

  return JSON.parse(candidate.slice(start, end + 1)) as T;
}
