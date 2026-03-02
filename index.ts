#!/usr/bin/env node
/**
 * Stdio MCP transport — runs via `npx mcp-greasy-fork`.
 * Two tools: search-scripts (HTML-parsed search) and get-script-details (JSON API + code fetch).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GREASYFORK_BASE = "https://greasyfork.org";
const MAX_CONCURRENCY = 10;
const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";

const HEADERS_HTML: Record<string, string> = {
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": USER_AGENT,
};

const HEADERS_JSON: Record<string, string> = {
  accept: "application/json",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": USER_AGENT,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GreasyForkScript {
  id: number;
  name: string;
  link: string;
  description: string;
  daily_installs: number;
  total_installs: number;
  rating_score: string;
  created: string;
  updated: string;
  version: string;
  code_url: string;
}

interface ScriptDetails {
  id: number | null;
  name?: string;
  description?: string;
  version?: string;
  authors?: string[];
  license?: string;
  url: string;
  daily_installs?: number;
  total_installs?: number;
  rating_score?: string;
  created_at?: string;
  code_updated_at?: string;
  code?: string | null;
  error: string | null;
}

interface GreasyForkMeta {
  id: number;
  name?: string;
  description?: string;
  version?: string;
  users?: { name: string }[];
  license?: string;
  url?: string;
  daily_installs?: number;
  total_installs?: number;
  fan_score?: string;
  created_at?: string;
  code_updated_at?: string;
  code_url?: string;
}

interface SearchQueryResult {
  scripts: GreasyForkScript[];
  pagesFetched: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

class Semaphore {
  private max: number;
  private current: number;
  private queue: Array<() => void>;

  constructor(max: number) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }

  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.current < this.max) {
        this.current++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release(): void {
    this.current--;
    if (this.queue.length > 0) {
      this.current++;
      this.queue.shift()!();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const semaphore = new Semaphore(MAX_CONCURRENCY);

// ---------------------------------------------------------------------------
// HTML Entity Decoding
// ---------------------------------------------------------------------------

function decodeEntities(str: string): string {
  if (!str) return "";
  return str
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_: string, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_: string, h: string) => String.fromCharCode(parseInt(h, 16)));
}

// ---------------------------------------------------------------------------
// HTML Fetch Helper
// ---------------------------------------------------------------------------

async function fetchHTML(url: string): Promise<string> {
  const resp = await fetch(url, { headers: HEADERS_HTML });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  return await resp.text();
}

// ---------------------------------------------------------------------------
// Parse Search Page HTML
// ---------------------------------------------------------------------------

function parseMaxPage(html: string): number {
  const navMatch = html.match(/<nav[^>]*class="[^"]*pagy[^"]*series-nav[^"]*"[^>]*>([\s\S]*?)<\/nav>/i);
  if (!navMatch) return 1;
  const nav = navMatch[1];
  const pageLinks = [...nav.matchAll(/[?&]page=(\d+)/g)];
  if (pageLinks.length === 0) return 1;
  return Math.max(...pageLinks.map((m) => parseInt(m[1], 10)));
}

function parseScriptsFromHTML(html: string): GreasyForkScript[] {
  const scripts: GreasyForkScript[] = [];
  const liRegex = /<li\s+[^>]*data-script-id="(\d+)"[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch: RegExpExecArray | null;

  while ((liMatch = liRegex.exec(html)) !== null) {
    const attrs = liMatch[0];
    const inner = liMatch[2];

    const get = (attr: string): string => {
      const m = attrs.match(new RegExp(`${attr}="([^"]*)"`));
      return m ? decodeEntities(m[1]) : "";
    };

    const id = parseInt(get("data-script-id"), 10);
    const name = get("data-script-name");
    const dailyInstalls = parseInt(get("data-script-daily-installs") || "0", 10);
    const totalInstalls = parseInt(get("data-script-total-installs") || "0", 10);
    const ratingScore = get("data-script-rating-score") || "0";
    const created = get("data-script-created-date");
    const updatedDate = get("data-script-updated-date");
    const version = get("data-script-version");
    const codeUrl = get("data-code-url");

    // Extract link
    const linkMatch = inner.match(/<a[^>]*class="[^"]*script-link[^"]*"[^>]*href="([^"]*)"/);
    const link = linkMatch ? GREASYFORK_BASE + decodeEntities(linkMatch[1]) : "";

    // Extract description
    const descMatch = inner.match(/<span[^>]*class="[^"]*script-description[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const description = descMatch ? decodeEntities(descMatch[1].replace(/<[^>]*>/g, "").trim()) : "";

    // Extract updated datetime from relative-time
    const rtMatch = inner.match(/<relative-time[^>]*datetime="([^"]*)"/);
    const updated = rtMatch ? rtMatch[1] : updatedDate;

    scripts.push({
      id,
      name,
      link,
      description,
      daily_installs: dailyInstalls,
      total_installs: totalInstalls,
      rating_score: ratingScore,
      created,
      updated,
      version,
      code_url: codeUrl,
    });
  }

  return scripts;
}

// ---------------------------------------------------------------------------
// Search: fetch all pages for a single query
// ---------------------------------------------------------------------------

async function searchQuery(query: string): Promise<SearchQueryResult> {
  const encoded = encodeURIComponent(query);
  const page1Url = `${GREASYFORK_BASE}/en/scripts?q=${encoded}&page=1`;

  const page1Html = await semaphore.run(() => fetchHTML(page1Url));
  const maxPage = parseMaxPage(page1Html);
  const scripts = parseScriptsFromHTML(page1Html);
  let pagesFetched = 1;

  if (maxPage > 1) {
    const remaining: number[] = [];
    for (let p = 2; p <= maxPage; p++) {
      remaining.push(p);
    }

    const results = await Promise.all(
      remaining.map((p) =>
        semaphore.run(async () => {
          const url = `${GREASYFORK_BASE}/en/scripts?q=${encoded}&page=${p}`;
          const html = await fetchHTML(url);
          return parseScriptsFromHTML(html);
        })
      )
    );

    for (const r of results) {
      scripts.push(...r);
    }
    pagesFetched += remaining.length;
  }

  return { scripts, pagesFetched };
}

// ---------------------------------------------------------------------------
// Tool 1 implementation: search-scripts
// ---------------------------------------------------------------------------

async function searchScripts(queries: string[]): Promise<{
  queries: string[];
  total_results: number;
  total_pages_fetched: number;
  scripts: GreasyForkScript[];
}> {
  const allScripts: GreasyForkScript[] = [];
  let totalPagesFetched = 0;
  const seenIds = new Set<number>();

  const queryResults = await Promise.all(
    queries.map(async (q): Promise<SearchQueryResult> => {
      try {
        return await searchQuery(q);
      } catch (err) {
        return { scripts: [], pagesFetched: 0, error: (err as Error).message };
      }
    })
  );

  for (const result of queryResults) {
    totalPagesFetched += result.pagesFetched || 0;
    for (const s of result.scripts) {
      if (!seenIds.has(s.id)) {
        seenIds.add(s.id);
        allScripts.push(s);
      }
    }
  }

  return {
    queries,
    total_results: allScripts.length,
    total_pages_fetched: totalPagesFetched,
    scripts: allScripts,
  };
}

// ---------------------------------------------------------------------------
// Tool 2 implementation: get-script-details
// ---------------------------------------------------------------------------

function extractScriptId(url: string): number | null {
  const m = url.match(/\/scripts\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function getScriptDetails(scriptUrls: string[]): Promise<ScriptDetails[]> {
  const results = await Promise.all(
    scriptUrls.map(async (url): Promise<ScriptDetails> => {
      const id = extractScriptId(url);
      if (!id) {
        return { id: null, url, error: `Could not extract script ID from URL: ${url}` };
      }

      try {
        const metaUrl = `${GREASYFORK_BASE}/en/scripts/${id}.json`;
        const metaResp = await semaphore.run(() =>
          fetch(metaUrl, { headers: HEADERS_JSON })
        );
        if (!metaResp.ok) {
          throw new Error(`HTTP ${metaResp.status} fetching metadata for script ${id}`);
        }
        const meta = (await metaResp.json()) as GreasyForkMeta;

        let code: string | null = null;
        if (meta.code_url) {
          try {
            code = await semaphore.run(async () => {
              const r = await fetch(meta.code_url!, { headers: { "user-agent": USER_AGENT } });
              return r.ok ? await r.text() : null;
            });
          } catch {
            // code fetch failed, continue with null
          }
        }

        return {
          id: meta.id,
          name: meta.name ?? "",
          description: meta.description ?? "",
          version: meta.version ?? "",
          authors: (meta.users ?? []).map((u) => u.name),
          license: meta.license ?? "",
          url: meta.url ?? "",
          daily_installs: meta.daily_installs ?? 0,
          total_installs: meta.total_installs ?? 0,
          rating_score: meta.fan_score ?? "0",
          created_at: meta.created_at ?? "",
          code_updated_at: meta.code_updated_at ?? "",
          code,
          error: null,
        };
      } catch (err) {
        return {
          id,
          url,
          error: err instanceof Error ? err.message : "Unknown error",
        };
      }
    })
  );

  return results;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "mcp-greasyfork-scripts",
  version: "1.0.0",
});

// Tool 1: search-scripts
server.tool(
  "search-scripts",
  "Search Greasy Fork (greasyfork.org) for userscripts by keyword. Accepts up to 10 search queries run in parallel — results are deduplicated across queries. Returns a TSV table (tab-separated: ID, Name, Description, Daily Installs, Total Installs, Rating, Created, Updated, Version, Link, Code URL). Maximum 1000 results shown; if more exist, a summary line indicates the overflow. Use IDs or URLs from results with get-script-details to fetch full source code.",
  {
    queries: z
      .array(z.string().min(1))
      .min(1)
      .max(10)
      .describe("Search keywords — each query is searched independently and results are deduplicated"),
  },
  async ({ queries }) => {
    try {
      const result = await searchScripts(queries);
      const MAX_DISPLAY = 1000;
      const scripts = result.scripts;
      const displayScripts = scripts.slice(0, MAX_DISPLAY);

      const cleanDesc = (d: string): string =>
        (d || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();

      let output = `Found ${result.total_results} scripts across ${result.total_pages_fetched} pages for ${queries.length} quer${queries.length === 1 ? "y" : "ies"}: ${queries.join(", ")}\n\n`;

      output += "ID\tName\tDescription\tDaily Installs\tTotal Installs\tRating\tCreated\tUpdated\tVersion\tLink\tCode URL\n";

      for (const s of displayScripts) {
        output += `${s.id}\t${s.name}\t${cleanDesc(s.description)}\t${s.daily_installs}\t${s.total_installs}\t${s.rating_score}\t${s.created}\t${s.updated}\t${s.version}\t${s.link}\t${s.code_url}\n`;
      }

      if (scripts.length > MAX_DISPLAY) {
        output += `\n+${scripts.length - MAX_DISPLAY} more results not shown. Try more specific search queries to narrow results.`;
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : "Unknown error"}` }], isError: true };
    }
  }
);

// Tool 2: get-script-details
server.tool(
  "get-script-details",
  "Fetch full metadata and source code for Greasy Fork userscripts. Pass up to 10 script URLs (e.g. https://greasyfork.org/en/scripts/487271-better-youtube-shorts). Returns a formatted report per script with metadata headers and the complete JavaScript source code in a fenced code block. Use script URLs or IDs from search-scripts results.",
  {
    script_urls: z
      .array(z.string().url())
      .min(1)
      .max(10)
      .describe("Array of Greasy Fork script URLs"),
  },
  async ({ script_urls }) => {
    try {
      const results = await getScriptDetails(script_urls);
      const parts = results.map((s) => {
        if (s.error) {
          return `# Script ${s.id || "Unknown"}\n\n**Error:** ${s.error}`;
        }

        let md = `# ${s.name}\n\n`;
        md += `## Metadata\n`;
        md += `- **ID:** ${s.id}\n`;
        md += `- **Author:** ${(s.authors || []).join(", ") || "Unknown"}\n`;
        md += `- **Version:** ${s.version}\n`;
        md += `- **License:** ${s.license}\n`;
        md += `- **Daily Installs:** ${s.daily_installs}\n`;
        md += `- **Total Installs:** ${s.total_installs}\n`;
        md += `- **Rating:** ${s.rating_score}\n`;
        md += `- **Created:** ${s.created_at}\n`;
        md += `- **Updated:** ${s.code_updated_at}\n`;
        md += `- **URL:** ${s.url}\n`;
        md += `\n## Source Code\n\n`;
        md += "```javascript\n";
        md += (s.code || "// Source code not available") + "\n";
        md += "```";

        return md;
      });

      return { content: [{ type: "text" as const, text: parts.join("\n\n---\n\n") }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : "Unknown error"}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
