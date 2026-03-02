# mcp-greasyfork-scripts

an mcp server that searches [greasy fork](https://greasyfork.org) and fetches userscript source code. gives your coding agent access to thousands of userscripts — tampermonkey, greasemonkey, violentmonkey scripts — as rich context.

## what it does

two tools:

### search-scripts

searches greasy fork by keyword. accepts up to 10 search queries in parallel, fetches all result pages concurrently (semaphore of 10), deduplicates by script id. returns results as a TSV table with id, name, description, install counts, ratings, dates, and code urls. maximum 1000 results displayed per call.

### get-script-details

takes greasy fork script urls and fetches complete metadata plus the full javascript source code. returns a formatted markdown report with metadata headers and fenced code blocks.

## how it works

- scrapes greasy fork search result pages (HTML parsing via regex on `data-script-*` attributes)
- fetches all pagination pages in parallel with concurrency control
- deduplicates scripts across multiple search queries
- fetches script metadata via greasy fork json api and source code from code urls
- no api keys or tokens required — greasy fork is fully public

## install

add to your mcp config:

```json
{
  "mcpServers": {
    "greasyfork": {
      "command": "npx",
      "args": ["-y", "mcp-greasyfork-scripts"]
    }
  }
}
```

## tools

### search-scripts

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `queries` | string[] | yes | 1-10 search keywords, each searched independently |

returns TSV with columns: ID, Name, Description, Daily Installs, Total Installs, Rating, Created, Updated, Version, Link, Code URL

### get-script-details

| parameter | type | required | description |
|-----------|------|----------|-------------|
| `script_urls` | string[] | yes | 1-10 greasy fork script urls |

returns markdown with metadata headers and full source code in fenced code blocks.

## license

mit
