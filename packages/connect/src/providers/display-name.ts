// Display names for model ids (`claude-sonnet-5-5` -> `Sonnet 5.5`). Display only: ids stay what routing, pricing and the
// server use. Unknown shapes fall back to a readable title-case of the id, never to something lossy.

const BRANDS: Record<string, string> = {
  gpt: "GPT", deepseek: "DeepSeek", gemini: "Gemini", glm: "GLM", qwen: "Qwen", kimi: "Kimi", grok: "Grok", llama: "Llama", mistral: "Mistral",
  codex: "Codex", flash: "Flash", pro: "Pro", mini: "Mini", nano: "Nano", lite: "Lite", max: "Max", turbo: "Turbo", astra: "Astra",
};

const isMinor = (t: string) => /^\d{1,2}$/.test(t);
// A trailing build date (`-20250219`, `-2025-02-19`) names a snapshot, not a model.
const DATE_TAIL = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

function titleCase(word: string): string {
  const brand = BRANDS[word.toLowerCase()];
  if (brand) return brand;
  if (/^v\d/i.test(word)) return `V${word.slice(1)}`;
  if (/^\d/.test(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Join runs of 1-2 digit tokens into one version (`5`,`5` -> `5.5`); a token already holding a dot stays as is. */
function mergeVersions(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    if (prev !== undefined && isMinor(t) && /^\d{1,2}(?:\.\d{1,2})*$/.test(prev) && !prev.includes(".")) out[out.length - 1] = `${prev}.${t}`;
    else out.push(t);
  }
  return out;
}

export function displayName(id: string): string {
  const raw = id.trim().replace(DATE_TAIL, "");
  if (!raw) return id;
  let tokens = raw.split(/[-_]/).filter(Boolean);
  const claude = tokens[0]?.toLowerCase() === "claude";
  if (claude) tokens = tokens.slice(1);
  tokens = mergeVersions(tokens);
  if (claude) {
    // `claude-3-5-sonnet` puts the version first; show it after the family like the newer ids.
    const v = tokens.findIndex((t) => /^\d/.test(t));
    const f = tokens.findIndex((t) => /^[a-z]/i.test(t));
    if (v === 0 && f > 0) tokens = [...tokens.slice(f), ...tokens.slice(0, f)];
  }
  const words = tokens.map(titleCase);
  // `gpt-6` reads GPT-6, not "GPT 6".
  if (tokens[0]?.toLowerCase() === "gpt" && words.length > 1 && /^\d/.test(words[1]!)) return [`${words[0]}-${words[1]}`, ...words.slice(2)].join(" ");
  return words.join(" ");
}
