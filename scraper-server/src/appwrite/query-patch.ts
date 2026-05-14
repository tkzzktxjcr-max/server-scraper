/**
 * Appwrite Query Adapter — converts JSON-object queries (SDK v16+)
 * into legacy string format expected by Appwrite Server 1.7.4.
 *
 * Problem:  SDK v16+ sends  queries[0]={"method":"equal","attribute":"x","values":["y"]}
 * Expected: Server 1.7.4 wants  queries[0]=equal("x",["y"])
 */

/**
 * Convert a single JSON query object to legacy string format
 */
function jsonQueryToString(q: unknown): string {
  try {
    const obj = q as Record<string, unknown>;
    const method = String(obj.method ?? "");
    if (!method) return String(q);

    const attr = JSON.stringify(obj.attribute ?? "");
    const vals = JSON.stringify(obj.values ?? []);

    return `${method}(${attr},${vals})`;
  } catch {
    return String(q);
  }
}

/**
 * Monkey-patch fetch() to intercept Appwrite queries and rewrite them
 * before they reach the server.
 */
export function installQueryPatch(): void {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();

    // Only patch Appwrite database endpoints
    if (!url.includes("/databases/") || !init?.body) {
      return originalFetch(input, init);
    }

    try {
      const parsed = new URL(url);
      const queries = parsed.searchParams.getAll("queries[]");

      if (queries.length === 0) {
        return originalFetch(input, init);
      }

      let modified = false;
      const newQueries: string[] = [];

      for (const raw of queries) {
        if (raw.trim().startsWith('{')) {
          // JSON object format → legacy string format
          try {
            const obj = JSON.parse(raw);
            newQueries.push(jsonQueryToString(obj));
            modified = true;
          } catch {
            newQueries.push(raw);
          }
        } else {
          newQueries.push(raw);
        }
      }

      if (modified) {
        const newUrl = new URL(parsed);
        newUrl.searchParams.delete("queries[]");
        for (const q of newQueries) {
          newUrl.searchParams.append("queries[]", q);
        }

        return originalFetch(newUrl.toString(), init);
      }
    } catch {
      // Patch failed silently, fall back to original request
    }

    return originalFetch(input, init);
  };
}
