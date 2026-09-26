import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { STACK_CONFIG, installMocks, resources, settleStack } from "../alerting/mock-harness";

/**
 * Guards the UI ↔ deployed-route seam for every service: each API call the web and mobile
 * clients make must hit a route the full stack actually creates. There is no OpenAPI
 * contract, and two mismatches shipped because nothing checked this (the riding-board
 * `/assign` vs `/assignments` path, and `platform/config/{configType}` routed as a bare
 * `/platform/config`), alongside whole services the UI calls that were never deployed.
 *
 * Checked: calls whose path is a string or template literal, including literals built by
 * a one-line path helper (`function unit(id): string { return `apparatus/${...}`; }`),
 * and the mobile offline outbox, which always POSTs (sync/outboxStore.ts) to the path its
 * enqueue helpers build. Not checked: calls through an arbitrary path variable.
 */

const UI_ROOT = path.resolve(__dirname, "../../../ui/apps");
const API_PREFIX = "/api/v1/";

/**
 * UI calls with no deployed route yet, keyed "METHOD /api/v1/path" with path parameters
 * normalized to `{}`. Deploying a route must remove its entry: the test fails on a stale
 * entry as well as on an unlisted gap, so this list is always the exact current gap.
 */
const KNOWN_UNDEPLOYED = new Set<string>([]);

interface UiCall {
  readonly method: string;
  readonly path: string;
  readonly file: string;
}

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "e2e" ? [] : listSourceFiles(full);
    }
    const isSource = /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name);
    return isSource && !entry.name.startsWith("mock") && !entry.name.startsWith("demo")
      ? [full]
      : [];
  });
}

/** Reads a template literal starting at src[start] === '`', honouring nested `${ ... }`. */
function readTemplate(src: string, start: number): { raw: string; end: number } {
  let i = start + 1;
  let raw = "";
  while (i < src.length && src[i] !== "`") {
    if (src[i] === "$" && src[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === "`") {
          j = readTemplate(src, j).end;
          continue;
        }
        if (src[j] === "{") depth++;
        if (src[j] === "}") depth--;
        j++;
      }
      raw += "\u0000";
      i = j;
      continue;
    }
    raw += src[i];
    i++;
  }
  return { raw, end: i + 1 };
}

/** Turns a literal path into "/api/v1/..." with each `${...}` segment as `{}`. */
function normalizeUiPath(raw: string): string {
  const withoutQuery = raw.split("?")[0]!;
  const segments = withoutQuery
    .split("/")
    .filter((s) => s.length > 0)
    // A placeholder that is a whole segment is a path parameter; one glued onto literal
    // text (e.g. `inspections${query}`) is a query-string builder and is dropped.
    .map((s) => (s === "\u0000" ? "{}" : s.split("\u0000").join("")));
  return `${API_PREFIX}${segments.join("/")}`;
}

const PATH_HELPER = /function (\w+)\(([^)]*)\): string \{\s*return `([^`]*)`;\s*\}/g;

/**
 * Inlines calls to one-line path helpers so the call site becomes a literal: `${unit(id)}`
 * inside a template and a bare `unitPath(id, 'checks')` argument both expand to the
 * helper's template, with any string-literal argument substituted for its parameter.
 */
function inlinePathHelpers(src: string): string {
  let out = src;
  for (const [, name, params, body] of src.matchAll(PATH_HELPER)) {
    const paramNames = params!.split(",").map((p) => p.split(":")[0]!.trim());
    const expand = (argList: string): string => {
      const args = argList.split(",").map((a) => a.trim());
      return paramNames.reduce((text, param, i) => {
        const literal = /^['"](.*)['"]$/.exec(args[i] ?? "")?.[1];
        return literal === undefined ? text : text.split(`\${${param}}`).join(literal);
      }, body!);
    };
    out = out
      .replace(new RegExp(`\\$\\{${name}\\(([^)]*)\\)\\}`, "g"), (_m, a: string) => expand(a))
      .replace(new RegExp(`(?<![\\w.])${name}\\(([^)]*)\\)`, "g"), (m, a: string) =>
        m.startsWith(`${name}(${params}`) ? m : `\`${expand(a)}\``,
      );
  }
  return out;
}

function extractUiCalls(): UiCall[] {
  const calls: UiCall[] = [];
  for (const file of listSourceFiles(UI_ROOT)) {
    const src = inlinePathHelpers(fs.readFileSync(file, "utf8"));
    if (file.endsWith(path.join("sync", "syncManager.ts"))) {
      // Each enqueueAndDrain(kind, key, label, path, ...) call: the path is the template
      // argument with no whitespace (the label is prose).
      for (const m of src.matchAll(/await enqueueAndDrain\(([^;]*)\);/g)) {
        for (const t of m[1]!.matchAll(/`([^`\s]*)`/g)) {
          calls.push({
            method: "POST",
            path: normalizeUiPath(t[1]!.replace(/\$\{[^}]*\}/g, "\u0000")),
            file: path.relative(UI_ROOT, file),
          });
        }
      }
    }
    const callSite = /\b(?:apiRequest|req)\(\s*/g;
    let match: RegExpExecArray | null;
    while ((match = callSite.exec(src)) !== null) {
      const argStart = match.index + match[0].length;
      const quote = src[argStart];
      let raw: string;
      let afterArg: number;
      if (quote === "'" || quote === '"') {
        afterArg = src.indexOf(quote, argStart + 1) + 1;
        raw = src.slice(argStart + 1, afterArg - 1);
      } else if (quote === "`") {
        ({ raw, end: afterArg } = readTemplate(src, argStart));
      } else {
        // A definition (`function req(path...)`) or a call through a path variable.
        continue;
      }
      // Scan the rest of the call (balanced parens) for an explicit method.
      let depth = 1;
      let i = afterArg;
      while (i < src.length && depth > 0) {
        if (src[i] === "(") depth++;
        if (src[i] === ")") depth--;
        i++;
      }
      const method = /method:\s*['"](\w+)['"]/.exec(src.slice(afterArg, i))?.[1] ?? "GET";
      calls.push({
        method: method.toUpperCase(),
        path: normalizeUiPath(raw),
        file: path.relative(UI_ROOT, file),
      });
    }
  }
  return calls;
}

interface DeployedRoute {
  readonly method: string;
  readonly segments: readonly string[];
}

function parseRouteKey(routeKey: string): DeployedRoute {
  const [method, routePath] = routeKey.split(" ") as [string, string];
  return {
    method,
    segments: routePath
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => (s.startsWith("{") ? (s.endsWith("+}") ? "{+}" : "{}") : s)),
  };
}

function matches(route: DeployedRoute, call: UiCall): boolean {
  if (route.method !== "ANY" && route.method !== call.method) return false;
  const callSegments = call.path.split("/").filter((s) => s.length > 0);
  for (let i = 0; i < route.segments.length; i++) {
    const segment = route.segments[i]!;
    if (segment === "{+}") return callSegments.length > i;
    const callSegment = callSegments[i];
    if (callSegment === undefined) return false;
    // A route parameter matches any value; a UI path parameter matches only a parameter,
    // never a literal segment (`apparatus/{id}/checklist` is not `apparatus/riding-board/…`).
    if (segment === "{}") continue;
    if (segment !== callSegment) return false;
  }
  return callSegments.length === route.segments.length;
}

describe("UI API calls ↔ deployed HTTP routes", { timeout: 120_000 }, () => {
  it("every UI call hits a deployed route, except the listed known gaps", async () => {
    installMocks(STACK_CONFIG);
    await import("../../index");
    await settleStack();

    const routes = resources
      .filter((r) => r.type === "aws:apigatewayv2/route:Route")
      .map((r) => parseRouteKey(r.inputs.routeKey as string));
    const calls = extractUiCalls();
    expect(routes.length).toBeGreaterThan(40);
    expect(calls.length).toBeGreaterThan(80);

    const key = (c: UiCall) => `${c.method} ${c.path}`;
    const unmatched = new Map<string, string[]>();
    for (const call of calls) {
      if (routes.some((route) => matches(route, call))) continue;
      unmatched.set(key(call), [...(unmatched.get(key(call)) ?? []), call.file]);
    }

    const unlisted = [...unmatched.entries()]
      .filter(([k]) => !KNOWN_UNDEPLOYED.has(k))
      .map(([k, files]) => `${k}  (${[...new Set(files)].join(", ")})`)
      .sort();
    const nowDeployed = [...KNOWN_UNDEPLOYED].filter((k) => !unmatched.has(k)).sort();

    expect(unlisted, "UI calls with no deployed route").toEqual([]);
    expect(nowDeployed, "KNOWN_UNDEPLOYED entries that now match a route — remove them").toEqual(
      [],
    );
  });
});
