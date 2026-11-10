/**
 * Provider presets for the AI settings dialog.
 *
 * The point of this file: nobody should have to know that a base URL and an
 * exact model id are needed before the "explain" button works. Pick a provider
 * from the list, paste a key, and both technical fields fill themselves in.
 *
 * Only providers listed here were picked deliberately; anything else goes
 * through "自定义（OpenAI 兼容）". Anything that speaks /chat/completions works
 * that way, including a local Ollama.
 *
 * Model lists go stale fast. They are a starting point only — the dialog asks
 * /models what the endpoint actually serves and replaces the list, so a wrong
 * guess here self-corrects instead of blocking the user.
 */
export interface Provider {
  id: string;
  label: string;
  /** Empty means the user must type the base URL themselves. */
  endpoint: string;
  hint: string;
  /** Best-guess model ids. Refreshed from /models once a key is entered. */
  models: string[];
}

export const PROVIDERS: Provider[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1",
    hint: "platform.deepseek.com",
    models: ["deepseek-flash", "deepseek-v4-pro"]
  },
  {
    id: "qwen",
    label: "通义千问",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    hint: "阿里云百炼 · bailian.console.aliyun.com",
    models: ["qwen-max", "qwen-plus", "qwen-turbo"]
  },
  {
    id: "kimi",
    label: "Kimi",
    endpoint: "https://api.moonshot.cn/v1",
    hint: "月之暗面 · platform.moonshot.cn",
    models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"]
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    endpoint: "https://open.bigmodel.cn/api/paas/v4",
    hint: "bigmodel.cn",
    models: ["glm-4-plus", "glm-4-air", "glm-4-flash"]
  },
  {
    id: "custom",
    label: "自定义",
    endpoint: "",
    hint: "OpenAI 兼容接口，含本机 Ollama",
    models: []
  }
];

/**
 * Which preset the user picked.
 *
 * Stored explicitly rather than guessed from the address: "自定义" keeps
 * whatever URL was already there, so a pure endpoint lookup would report the
 * previous provider and keep hiding the editable field.
 */
export function providerOf(cfg: { provider?: string; endpoint: string }): Provider {
  const explicit = PROVIDERS.find((p) => p.id === cfg.provider);
  if (explicit) return explicit;
  const norm = cfg.endpoint.trim().replace(/\/+$/, "");
  return (
    PROVIDERS.find((p) => p.endpoint && p.endpoint.replace(/\/+$/, "") === norm) ??
    PROVIDERS[PROVIDERS.length - 1]
  );
}

/**
 * A loopback endpoint is almost always Ollama or another local server, which
 * takes no key. Mirrors the same check in lib.rs so the button enables on the
 * same rule the backend enforces.
 */
export function isLocalEndpoint(endpoint: string): boolean {
  const e = endpoint.trim().toLowerCase();
  return e.includes("127.0.0.1") || e.includes("localhost") || e.includes("0.0.0.0");
}
