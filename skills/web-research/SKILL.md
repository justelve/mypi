---
name: web-research
description: Live web search and deep research workflows using the web_search, web_fetch, and deep_research tools. Use when the user asks for current information, source-backed answers, external documentation, news, market data, recent changes, or any question that benefits from web citations.
allowed-tools: web_search web_fetch deep_research read
---

# Web Research

Use this skill when a task needs information from the live web or verifiable external sources.

## Available tools

- `web_search`: find ranked web results and source URLs.
- `web_fetch`: fetch a specific URL and extract readable page text.
- `deep_research`: search and fetch several top results into a citation-ready research bundle.

Provider selection is automatic by default:

1. Brave (`BRAVE_SEARCH_API_KEY`)
2. Tavily (`TAVILY_API_KEY`)
3. Serper (`SERPER_API_KEY`)
4. Kagi (`KAGI_API_KEY`)
5. DuckDuckGo HTML fallback

Use `/web-research-status` to show configured providers.

## Workflow

### Quick current-facts answer

1. Call `web_search` with a focused query.
2. Inspect titles, snippets, dates, and URLs.
3. Call `web_fetch` for any result whose details you rely on.
4. Answer with citations as links or numbered source references.

### Deep research answer

1. Call `deep_research` with the user's question.
2. Use the returned numbered sources and fetched excerpts.
3. Prefer fetched page text over search snippets.
4. If an important source failed to fetch, either fetch an alternate source or state that the claim is based only on a snippet.
5. Synthesize rather than paste large excerpts.

### Documentation lookup

1. Call `web_search` with the library/tool name, version if known, and the specific API/topic.
2. Prefer official docs, source repositories, changelogs, or standards pages.
3. Call `web_fetch` on the official/primary page before giving code or configuration advice.

## Citation guidance

- Cite concrete URLs for factual claims from the web.
- Prefer primary sources over blogs, SEO pages, or aggregators.
- Mention publication or update dates when relevant.
- If sources disagree, explain the disagreement and cite both sides.
- Do not cite search snippets as verified facts unless no page fetch is possible; label them as snippets.

## Tool selection

- Use `web_search` when you need candidates or only a small set of URLs.
- Use `web_fetch` when the user gives a URL or when validating details from a search result.
- Use `deep_research` when the answer needs multiple sources, comparison, recent developments, or a cited briefing.

## Limits

Tool output is truncated for context safety. If a result mentions a temp file containing full output, use `read` on that file only if the truncated output is insufficient.
