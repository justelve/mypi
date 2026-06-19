import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const SEARCH_PROVIDERS = [
  "auto",
  "brave",
  "tavily",
  "serper",
  "kagi",
  "duckduckgo",
] as const;
const SEARCH_DEPTHS = ["basic", "advanced"] as const;
const SAFE_SEARCH = ["off", "moderate", "strict"] as const;

const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 20;
const DEFAULT_RESEARCH_RESULTS = 8;
const DEFAULT_RESEARCH_PAGES = 5;
const MAX_RESEARCH_PAGES = 10;
const DEFAULT_PER_PAGE_CHARS = 8_000;
const MAX_PER_PAGE_CHARS = 20_000;
const MAX_FETCH_BYTES = Number(process.env.PI_WEB_MAX_FETCH_BYTES ?? 2_000_000);
const USER_AGENT =
  process.env.PI_WEB_USER_AGENT ??
  "Mozilla/5.0 (compatible; pi-web-research/1.0; +https://pi.dev/)";

type SearchProvider = (typeof SEARCH_PROVIDERS)[number];
type SearchDepth = (typeof SEARCH_DEPTHS)[number];
type SafeSearch = (typeof SAFE_SEARCH)[number];

type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
  published?: string;
  source?: string;
  score?: number;
};

type SearchDetails = {
  provider: SearchProvider;
  query: string;
  resultCount: number;
  results: SearchResult[];
  answer?: string;
};

type FetchDetails = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title?: string;
  description?: string;
  length: number;
  truncation?: TruncationResult;
  fullOutputPath?: string;
};

type ResearchDetails = {
  provider: SearchProvider;
  query: string;
  resultCount: number;
  fetchedCount: number;
  sources: Array<SearchResult & { fetched?: boolean; title?: string }>;
  failures: Array<{ url: string; error: string }>;
  truncation?: TruncationResult;
  fullOutputPath?: string;
};

const WebSearchParams = Type.Object({
  query: Type.String({ description: "Search query" }),
  maxResults: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_SEARCH_RESULTS,
      description: `Number of results to return (default ${DEFAULT_SEARCH_RESULTS}, max ${MAX_SEARCH_RESULTS})`,
    }),
  ),
  provider: Type.Optional(
    StringEnum(SEARCH_PROVIDERS, {
      description:
        "Search provider. auto uses the first configured API provider, then DuckDuckGo HTML fallback.",
    }),
  ),
  searchDepth: Type.Optional(
    StringEnum(SEARCH_DEPTHS, {
      description: "Tavily only: basic or advanced search depth",
    }),
  ),
  includeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Restrict results to these domains when supported, otherwise post-filter",
    }),
  ),
  excludeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Exclude these domains when supported, otherwise post-filter",
    }),
  ),
  safeSearch: Type.Optional(
    StringEnum(SAFE_SEARCH, {
      description: "Safe-search level where supported (default moderate)",
    }),
  ),
});

const WebFetchParams = Type.Object({
  url: Type.String({ description: "HTTP(S) URL to fetch" }),
  maxCharacters: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: DEFAULT_MAX_BYTES,
      description: `Maximum extracted characters to return before normal ${formatSize(DEFAULT_MAX_BYTES)} tool truncation`,
    }),
  ),
});

const DeepResearchParams = Type.Object({
  query: Type.String({ description: "Research question or topic" }),
  maxSearchResults: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_SEARCH_RESULTS,
      description: `Search results to collect (default ${DEFAULT_RESEARCH_RESULTS}, max ${MAX_SEARCH_RESULTS})`,
    }),
  ),
  maxPages: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_RESEARCH_PAGES,
      description: `Top pages to fetch and extract (default ${DEFAULT_RESEARCH_PAGES}, max ${MAX_RESEARCH_PAGES})`,
    }),
  ),
  provider: Type.Optional(
    StringEnum(SEARCH_PROVIDERS, {
      description:
        "Search provider. auto uses the first configured API provider, then DuckDuckGo HTML fallback.",
    }),
  ),
  searchDepth: Type.Optional(
    StringEnum(SEARCH_DEPTHS, {
      description: "Tavily only: basic or advanced search depth",
    }),
  ),
  includeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Restrict results to these domains when supported, otherwise post-filter",
    }),
  ),
  excludeDomains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Exclude these domains when supported, otherwise post-filter",
    }),
  ),
  safeSearch: Type.Optional(StringEnum(SAFE_SEARCH)),
  perPageCharacters: Type.Optional(
    Type.Integer({
      minimum: 500,
      maximum: MAX_PER_PAGE_CHARS,
      description: `Maximum extracted characters per fetched page (default ${DEFAULT_PER_PAGE_CHARS})`,
    }),
  ),
});

function clampInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value!)));
}

function configuredProviders(): SearchProvider[] {
  const requested = process.env.PI_WEB_SEARCH_PROVIDER as
    | SearchProvider
    | undefined;
  if (
    requested &&
    requested !== "auto" &&
    SEARCH_PROVIDERS.includes(requested)
  ) {
    return [requested];
  }

  const providers: SearchProvider[] = [];
  if (process.env.BRAVE_SEARCH_API_KEY) providers.push("brave");
  if (process.env.TAVILY_API_KEY) providers.push("tavily");
  if (process.env.SERPER_API_KEY) providers.push("serper");
  if (process.env.KAGI_API_KEY) providers.push("kagi");
  providers.push("duckduckgo");
  return providers;
}

function selectedProviders(
  provider: SearchProvider | undefined,
): SearchProvider[] {
  if (provider && provider !== "auto") return [provider];
  return configuredProviders();
}

function missingProviderMessage(provider: SearchProvider): string | undefined {
  if (provider === "brave" && !process.env.BRAVE_SEARCH_API_KEY) {
    return "BRAVE_SEARCH_API_KEY is not set";
  }
  if (provider === "tavily" && !process.env.TAVILY_API_KEY) {
    return "TAVILY_API_KEY is not set";
  }
  if (provider === "serper" && !process.env.SERPER_API_KEY) {
    return "SERPER_API_KEY is not set";
  }
  if (provider === "kagi" && !process.env.KAGI_API_KEY) {
    return "KAGI_API_KEY is not set";
  }
}

function normalizeSafeSearch(value?: SafeSearch): SafeSearch {
  return value ?? "moderate";
}

function hostMatches(url: string, domains: string[] | undefined): boolean {
  if (!domains?.length) return false;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((domain) => {
    const normalized = domain
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "");
    const hostWithoutWww = host.replace(/^www\./, "");
    return (
      hostWithoutWww === normalized || hostWithoutWww.endsWith(`.${normalized}`)
    );
  });
}

function filterDomains(
  results: SearchResult[],
  includeDomains?: string[],
  excludeDomains?: string[],
): SearchResult[] {
  return results.filter((result) => {
    if (includeDomains?.length && !hostMatches(result.url, includeDomains))
      return false;
    if (excludeDomains?.length && hostMatches(result.url, excludeDomains))
      return false;
    return true;
  });
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal,
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `${response.status} ${response.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`,
    );
  }

  return (await response.json()) as T;
}

async function searchBrave(
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
  options: {
    includeDomains?: string[];
    excludeDomains?: string[];
    safeSearch?: SafeSearch;
  },
): Promise<{ results: SearchResult[]; answer?: string }> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) throw new Error("BRAVE_SEARCH_API_KEY is not set");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  url.searchParams.set("text_decorations", "false");
  url.searchParams.set("safesearch", normalizeSafeSearch(options.safeSearch));

  const data = await fetchJson<{
    web?: {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
        age?: string;
      }>;
    };
    query?: { altered?: string };
  }>(url.toString(), { headers: { "X-Subscription-Token": key } }, signal);

  const results = (data.web?.results ?? [])
    .filter((item) => item.url)
    .map((item) => ({
      title: item.title ?? item.url!,
      url: item.url!,
      snippet: item.description,
      published: item.age,
      source: "brave",
    }));

  return {
    results: filterDomains(
      results,
      options.includeDomains,
      options.excludeDomains,
    ),
  };
}

async function searchTavily(
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
  options: {
    searchDepth?: SearchDepth;
    includeDomains?: string[];
    excludeDomains?: string[];
  },
): Promise<{ results: SearchResult[]; answer?: string }> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY is not set");

  const data = await fetchJson<{
    answer?: string;
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      score?: number;
      published_date?: string;
    }>;
  }>(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: options.searchDepth ?? "basic",
        max_results: maxResults,
        include_answer: true,
        include_raw_content: false,
        include_domains: options.includeDomains,
        exclude_domains: options.excludeDomains,
      }),
    },
    signal,
  );

  return {
    answer: data.answer,
    results: (data.results ?? [])
      .filter((item) => item.url)
      .map((item) => ({
        title: item.title ?? item.url!,
        url: item.url!,
        snippet: item.content,
        score: item.score,
        published: item.published_date,
        source: "tavily",
      })),
  };
}

async function searchSerper(
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
  options: {
    includeDomains?: string[];
    excludeDomains?: string[];
  },
): Promise<{ results: SearchResult[]; answer?: string }> {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("SERPER_API_KEY is not set");

  const data = await fetchJson<{
    answerBox?: { answer?: string; snippet?: string };
    organic?: Array<{
      title?: string;
      link?: string;
      snippet?: string;
      date?: string;
    }>;
  }>(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-KEY": key },
      body: JSON.stringify({ q: query, num: maxResults }),
    },
    signal,
  );

  const results = (data.organic ?? [])
    .filter((item) => item.link)
    .map((item) => ({
      title: item.title ?? item.link!,
      url: item.link!,
      snippet: item.snippet,
      published: item.date,
      source: "serper",
    }));

  return {
    answer: data.answerBox?.answer ?? data.answerBox?.snippet,
    results: filterDomains(
      results,
      options.includeDomains,
      options.excludeDomains,
    ),
  };
}

async function searchKagi(
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
  options: {
    includeDomains?: string[];
    excludeDomains?: string[];
  },
): Promise<{ results: SearchResult[]; answer?: string }> {
  const key = process.env.KAGI_API_KEY;
  if (!key) throw new Error("KAGI_API_KEY is not set");

  const url = new URL("https://kagi.com/api/v0/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(maxResults));

  const data = await fetchJson<{
    data?: Array<{
      t?: number;
      title?: string;
      url?: string;
      snippet?: string;
      published?: string;
    }>;
  }>(url.toString(), { headers: { Authorization: `Bot ${key}` } }, signal);

  const results = (data.data ?? [])
    .filter((item) => item.url && item.t === 0)
    .map((item) => ({
      title: item.title ?? item.url!,
      url: item.url!,
      snippet: item.snippet,
      published: item.published,
      source: "kagi",
    }));

  return {
    results: filterDomains(
      results,
      options.includeDomains,
      options.excludeDomains,
    ),
  };
}

async function searchDuckDuckGo(
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
  options: {
    includeDomains?: string[];
    excludeDomains?: string[];
    safeSearch?: SafeSearch;
  },
): Promise<{ results: SearchResult[]; answer?: string }> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  url.searchParams.set(
    "kp",
    normalizeSafeSearch(options.safeSearch) === "off" ? "-2" : "1",
  );

  const response = await fetch(url, {
    signal,
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}`);
  const html = await response.text();
  const results = parseDuckDuckGoResults(html)
    .slice(0, maxResults * 2)
    .filter((result) => result.url)
    .map((result) => ({ ...result, source: "duckduckgo" }));

  return {
    results: filterDomains(
      results,
      options.includeDomains,
      options.excludeDomains,
    ).slice(0, maxResults),
  };
}

function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*result[^"]*"/i).slice(1);

  for (const block of blocks) {
    const linkMatch = block.match(
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!linkMatch) continue;

    const rawUrl = decodeHtml(linkMatch[1]);
    const url = normalizeDuckDuckGoUrl(rawUrl);
    const title = cleanText(linkMatch[2]);
    const snippetMatch =
      block.match(
        /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
      ) ??
      block.match(
        /<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      );
    const snippet = snippetMatch ? cleanText(snippetMatch[1]) : undefined;

    if (url && title) results.push({ title, url, snippet });
  }

  return dedupeResults(results);
}

function normalizeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.toString();
  } catch {
    return rawUrl;
  }
}

async function runSearch(
  params: {
    query: string;
    maxResults?: number;
    provider?: SearchProvider;
    searchDepth?: SearchDepth;
    includeDomains?: string[];
    excludeDomains?: string[];
    safeSearch?: SafeSearch;
  },
  signal?: AbortSignal,
): Promise<SearchDetails> {
  const maxResults = clampInteger(
    params.maxResults,
    DEFAULT_SEARCH_RESULTS,
    1,
    MAX_SEARCH_RESULTS,
  );
  const errors: string[] = [];

  for (const provider of selectedProviders(params.provider)) {
    const missing = missingProviderMessage(provider);
    if (missing) {
      errors.push(`${provider}: ${missing}`);
      continue;
    }

    try {
      const { results, answer } = await searchWithProvider(
        provider,
        params.query,
        maxResults,
        signal,
        params,
      );
      return {
        provider,
        query: params.query,
        resultCount: results.length,
        results: dedupeResults(results).slice(0, maxResults),
        answer,
      };
    } catch (error) {
      errors.push(
        `${provider}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(`All web search providers failed. ${errors.join("; ")}`);
}

function searchWithProvider(
  provider: SearchProvider,
  query: string,
  maxResults: number,
  signal: AbortSignal | undefined,
  options: {
    searchDepth?: SearchDepth;
    includeDomains?: string[];
    excludeDomains?: string[];
    safeSearch?: SafeSearch;
  },
): Promise<{ results: SearchResult[]; answer?: string }> {
  if (provider === "brave")
    return searchBrave(query, maxResults, signal, options);
  if (provider === "tavily")
    return searchTavily(query, maxResults, signal, options);
  if (provider === "serper")
    return searchSerper(query, maxResults, signal, options);
  if (provider === "kagi")
    return searchKagi(query, maxResults, signal, options);
  return searchDuckDuckGo(query, maxResults, signal, options);
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of results) {
    const key = normalizeUrlForDedupe(result.url);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

function normalizeUrlForDedupe(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key))
        parsed.searchParams.delete(key);
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, num) =>
      String.fromCodePoint(Number.parseInt(num, 10)),
    );
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

function cleanText(htmlOrText: string): string {
  return decodeHtml(stripTags(htmlOrText)).replace(/\s+/g, " ").trim();
}

function extractMeta(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>|<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`,
    "i",
  );
  const match = html.match(re);
  return match ? decodeHtml(match[1] ?? match[2] ?? "").trim() : undefined;
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanText(match[1]) : undefined;
}

function htmlToReadableText(html: string): string {
  const main = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(
      /<\/(p|div|section|article|main|header|footer|li|tr|h[1-6])>/gi,
      "\n",
    )
    .replace(/<br\s*\/?>/gi, "\n");

  return decodeHtml(stripTags(main))
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readResponseWithLimit(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return response.text();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (received < maxBytes) {
    if (signal?.aborted) throw new Error("Cancelled");
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (received >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }

  return Buffer.concat(chunks, Math.min(received, maxBytes)).toString("utf8");
}

async function fetchPage(
  url: string,
  signal?: AbortSignal,
): Promise<{ text: string; details: FetchDetails }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  const response = await fetch(parsed, {
    redirect: "follow",
    signal,
    headers: {
      "user-agent": USER_AGENT,
      accept:
        "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
    },
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}`);

  const raw = await readResponseWithLimit(response, MAX_FETCH_BYTES, signal);
  const finalUrl = response.url || url;
  const isHtml = /html|xml/i.test(contentType) || /^\s*</.test(raw);
  const isJson = /json/i.test(contentType);
  const title = isHtml ? extractTitle(raw) : undefined;
  const description = isHtml
    ? (extractMeta(raw, "description") ?? extractMeta(raw, "og:description"))
    : undefined;

  let text: string;
  if (isHtml) {
    text = htmlToReadableText(raw);
  } else if (isJson) {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      text = raw;
    }
  } else if (/^text\//i.test(contentType) || !contentType) {
    text = raw.trim();
  } else {
    text = `[Fetched ${contentType || "unknown content type"}; binary or unsupported content omitted.]`;
  }

  return {
    text,
    details: {
      url,
      finalUrl,
      status: response.status,
      contentType,
      title,
      description,
      length: text.length,
    },
  };
}

async function truncateAndMaybeSave(text: string, prefix: string) {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated)
    return {
      text: truncation.content,
      truncation: undefined,
      fullOutputPath: undefined,
    };

  const tempDir = await mkdtemp(join(tmpdir(), `pi-${prefix}-`));
  const tempFile = join(tempDir, "output.txt");
  await withFileMutationQueue(tempFile, async () => {
    await writeFile(tempFile, text, "utf8");
  });

  const notice = `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
    truncation.outputBytes,
  )} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;

  return {
    text: truncation.content + notice,
    truncation,
    fullOutputPath: tempFile,
  };
}

function formatSearchResults(details: SearchDetails): string {
  const lines = [
    `Search provider: ${details.provider}`,
    `Query: ${details.query}`,
  ];
  if (details.answer) lines.push("", `Answer: ${details.answer}`);
  lines.push("", `Results (${details.resultCount}):`);
  details.results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`);
    lines.push(`   URL: ${result.url}`);
    if (result.published) lines.push(`   Published: ${result.published}`);
    if (result.snippet) lines.push(`   Snippet: ${result.snippet}`);
  });
  return lines.join("\n");
}

function excerpt(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters).trimEnd()}\n[Excerpt truncated at ${maxCharacters} characters]`;
}

async function runDeepResearch(
  params: {
    query: string;
    maxSearchResults?: number;
    maxPages?: number;
    provider?: SearchProvider;
    searchDepth?: SearchDepth;
    includeDomains?: string[];
    excludeDomains?: string[];
    safeSearch?: SafeSearch;
    perPageCharacters?: number;
  },
  signal?: AbortSignal,
): Promise<{ text: string; details: ResearchDetails }> {
  const maxSearchResults = clampInteger(
    params.maxSearchResults,
    DEFAULT_RESEARCH_RESULTS,
    1,
    MAX_SEARCH_RESULTS,
  );
  const maxPages = clampInteger(
    params.maxPages,
    DEFAULT_RESEARCH_PAGES,
    0,
    MAX_RESEARCH_PAGES,
  );
  const perPageCharacters = clampInteger(
    params.perPageCharacters,
    DEFAULT_PER_PAGE_CHARS,
    500,
    MAX_PER_PAGE_CHARS,
  );

  const search = await runSearch(
    { ...params, maxResults: maxSearchResults },
    signal,
  );
  const sources = search.results.map((result) => ({ ...result }));
  const failures: Array<{ url: string; error: string }> = [];
  const lines = [
    `Research bundle for: ${params.query}`,
    `Search provider: ${search.provider}`,
    "",
    "Use the numbered sources below for citations. Prefer primary sources and mention uncertainty.",
  ];

  if (search.answer)
    lines.push("", `Search provider answer/snippet: ${search.answer}`);

  lines.push("", "Sources:");
  sources.forEach((source, index) => {
    lines.push(`[${index + 1}] ${source.title}`);
    lines.push(`    ${source.url}`);
    if (source.published) lines.push(`    Published: ${source.published}`);
    if (source.snippet) lines.push(`    Search snippet: ${source.snippet}`);
  });

  lines.push("", "Fetched page excerpts:");

  let fetchedCount = 0;
  for (let index = 0; index < Math.min(maxPages, sources.length); index++) {
    const source = sources[index];
    try {
      const page = await fetchPage(source.url, signal);
      fetchedCount += 1;
      source.fetched = true;
      source.title = page.details.title ?? source.title;
      lines.push("", `[${index + 1}] ${source.title}`);
      lines.push(`URL: ${page.details.finalUrl}`);
      if (page.details.description)
        lines.push(`Description: ${page.details.description}`);
      lines.push("Excerpt:");
      lines.push(excerpt(page.text, perPageCharacters));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ url: source.url, error: message });
      lines.push("", `[${index + 1}] ${source.title}`);
      lines.push(`URL: ${source.url}`);
      lines.push(`Fetch failed: ${message}`);
    }
  }

  return {
    text: lines.join("\n"),
    details: {
      provider: search.provider,
      query: params.query,
      resultCount: sources.length,
      fetchedCount,
      sources,
      failures,
    },
  };
}

function providerStatusText(): string {
  const rows = [
    `Default provider order: ${configuredProviders().join(" -> ")}`,
    `BRAVE_SEARCH_API_KEY: ${process.env.BRAVE_SEARCH_API_KEY ? "set" : "not set"}`,
    `TAVILY_API_KEY: ${process.env.TAVILY_API_KEY ? "set" : "not set"}`,
    `SERPER_API_KEY: ${process.env.SERPER_API_KEY ? "set" : "not set"}`,
    `KAGI_API_KEY: ${process.env.KAGI_API_KEY ? "set" : "not set"}`,
    `DuckDuckGo HTML fallback: always available (best effort)`,
    `Fetch byte cap: ${formatSize(MAX_FETCH_BYTES)}`,
  ];
  return rows.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("web-research-status", {
    description: "Show web search/deep research provider configuration",
    handler: async (_args, ctx) => {
      ctx.ui.notify(providerStatusText(), "info");
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: `Search the web and return ranked results. Supports Brave, Tavily, Serper, Kagi, and DuckDuckGo fallback. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet:
      "Search the live web for current facts, documentation, news, and source URLs.",
    promptGuidelines: [
      "Use web_search when the user asks for current information, external documentation, news, or facts likely to have changed.",
      "When using web_search, cite source URLs from the returned results and fetch important pages with web_fetch before relying on details.",
    ],
    parameters: WebSearchParams,
    async execute(_toolCallId, params, signal) {
      const details = await runSearch(params, signal);
      return {
        content: [{ type: "text", text: formatSearchResults(details) }],
        details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_search "))}${theme.fg("accent", `"${args.query ?? ""}"`)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "Searching web..."), 0, 0);
      const details = result.details as SearchDetails | undefined;
      if (!details) return new Text(theme.fg("dim", "No search details"), 0, 0);
      let text = `${theme.fg("success", `${details.resultCount} results`)} ${theme.fg("muted", `via ${details.provider}`)}`;
      if (expanded) {
        for (const [index, item] of details.results.entries()) {
          text += `\n${theme.fg("accent", `[${index + 1}]`)} ${item.title}\n${theme.fg("dim", item.url)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: `Fetch an HTTP(S) URL and extract readable text from HTML, plain text, or JSON. Response downloads are capped at ${formatSize(MAX_FETCH_BYTES)} and tool output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved to a temp file if truncated.`,
    promptSnippet: "Fetch and extract readable text from a web page URL.",
    promptGuidelines: [
      "Use web_fetch on source URLs from web_search before citing page details or quoting content.",
      "When using web_fetch, cite the fetched URL and distinguish fetched page text from search snippets.",
    ],
    parameters: WebFetchParams,
    async execute(_toolCallId, params, signal) {
      const page = await fetchPage(params.url, signal);
      const maxCharacters = clampInteger(
        params.maxCharacters,
        DEFAULT_MAX_BYTES,
        1,
        DEFAULT_MAX_BYTES,
      );
      const header = [
        `URL: ${page.details.finalUrl}`,
        page.details.title ? `Title: ${page.details.title}` : undefined,
        page.details.description
          ? `Description: ${page.details.description}`
          : undefined,
        `Content-Type: ${page.details.contentType || "unknown"}`,
        "",
      ]
        .filter(Boolean)
        .join("\n");
      const rawText = header + excerpt(page.text, maxCharacters);
      const truncated = await truncateAndMaybeSave(rawText, "web-fetch");
      page.details.truncation = truncated.truncation;
      page.details.fullOutputPath = truncated.fullOutputPath;

      return {
        content: [{ type: "text", text: truncated.text }],
        details: page.details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_fetch "))}${theme.fg("accent", args.url ?? "")}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "Fetching page..."), 0, 0);
      const details = result.details as FetchDetails | undefined;
      if (!details) return new Text(theme.fg("dim", "No fetch details"), 0, 0);
      let text = theme.fg("success", "Fetched");
      if (details.title) text += ` ${theme.fg("accent", details.title)}`;
      if (details.truncation?.truncated)
        text += theme.fg("warning", " (truncated)");
      if (expanded) {
        text += `\n${theme.fg("dim", details.finalUrl)}`;
        if (details.fullOutputPath)
          text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "deep_research",
    label: "Deep Research",
    description: `Run a web search, fetch top pages, and return a citation-ready research bundle. Supports Brave, Tavily, Serper, Kagi, and DuckDuckGo fallback. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; full output is saved to a temp file if truncated.`,
    promptSnippet:
      "Search the web and fetch multiple top pages into a citation-ready research bundle.",
    promptGuidelines: [
      "Use deep_research for broad or current research questions that need multiple web sources and citations.",
      "After deep_research, synthesize an answer with citations using the numbered source list; do not treat snippets as verified if page fetch failed.",
    ],
    parameters: DeepResearchParams,
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({
        content: [{ type: "text", text: "Searching and fetching sources..." }],
      });
      const research = await runDeepResearch(params, signal);
      const truncated = await truncateAndMaybeSave(
        research.text,
        "deep-research",
      );
      research.details.truncation = truncated.truncation;
      research.details.fullOutputPath = truncated.fullOutputPath;

      return {
        content: [{ type: "text", text: truncated.text }],
        details: research.details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("deep_research "))}${theme.fg("accent", `"${args.query ?? ""}"`)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial)
        return new Text(theme.fg("warning", "Researching..."), 0, 0);
      const details = result.details as ResearchDetails | undefined;
      if (!details)
        return new Text(theme.fg("dim", "No research details"), 0, 0);
      let text = `${theme.fg("success", `${details.fetchedCount}/${details.resultCount} pages fetched`)} ${theme.fg("muted", `via ${details.provider}`)}`;
      if (details.failures.length)
        text += theme.fg("warning", ` (${details.failures.length} failed)`);
      if (details.truncation?.truncated)
        text += theme.fg("warning", " (truncated)");
      if (expanded) {
        for (const [index, item] of details.sources.entries()) {
          text += `\n${theme.fg("accent", `[${index + 1}]`)} ${item.title}\n${theme.fg("dim", item.url)}`;
        }
        if (details.fullOutputPath)
          text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
      }
      return new Text(text, 0, 0);
    },
  });
}
