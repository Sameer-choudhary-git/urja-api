import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeDevalue, filterEnergy, generateEnergy, meterPageData, type FakeEnergyRow } from "./fakeEnergy.js";

const COOKIE_NAME = "__Secure-better-auth.session_token";

export interface FakePortalOptions {
  readonly email?: string;
  readonly password?: string;
  readonly maxAgeSeconds?: number;
  /** Rows served by `/portal/dts`, 20 per page. */
  readonly transformers?: readonly unknown[];
  /** Items served by the signed export. */
  readonly exportMeters?: readonly unknown[];
  /**
   * "fixed": one signing secret for everybody.
   * "per-session": every login gets its own secret, and a signature made with
   * another session's secret is rejected. Lets tests prove we refetch keys.
   */
  readonly secretMode?: "fixed" | "per-session";
  /** How far x-timestamp may be from the server clock (seconds). */
  readonly maxTimestampSkewSeconds?: number;
  /**
   * Energy rows per meter. Default: generated June 2026 data for every meter
   * in `exportMeters`. Return undefined for "meter not found".
   */
  readonly energy?: (meterId: string) => readonly FakeEnergyRow[] | undefined;
  /**
   * Chaos mode for /portal/* calls: each request first waits a random 0..maxLatencyMs,
   * then fails with a random 500/502/503/429 with probability failureRate.
   * Seeded, so a failing run can be replayed.
   */
  readonly chaos?: { readonly failureRate: number; readonly maxLatencyMs: number; readonly seed?: number };
}

export interface ExportRequestRecord {
  readonly timestamp: string | undefined;
  readonly accepted: boolean;
}

export interface FakePortal {
  readonly baseUrl: string;
  readonly stats: {
    logins: number;
    searchRequests: number;
    keysRequests: number;
    exportRequests: ExportRequestRecord[];
    /** Query string of every energy request, e.g. "J100000?from=2026-06-29&to=2026-06-30". */
    energyRequests: string[];
    /** Highest number of /portal/* requests being handled at the same time. */
    maxInFlight: number;
  };
  /** true: every /portal/* request and login answers 503, as if the portal were down. */
  setDown(down: boolean): void;
  /** The next `times` energy requests answer with `status`. */
  failNextEnergy(status: number, times: number): void;
  /** Simulates server-side session expiry: every issued cookie stops working. */
  expireAllSessions(): void;
  /** The next `times` search requests answer with `status` before recovering. */
  failNextSearches(status: number, times: number): void;
  /** The next search request waits this long before answering. */
  delayNextSearch(ms: number): void;
  /** The next `times` export requests answer with `status` (after the signature check). */
  failNextExports(status: number, times: number): void;
  /** Expire every session right after the next `/portal/keys` answer (mid-flight expiry). */
  expireSessionsAfterNextKeys(): void;
  /** Make the export lie about `total`, as if it had become paginated. */
  setExportTotal(total: number | null): void;
  close(): Promise<void>;
}

/**
 * A small in-process imitation of the legacy portal, built only from behaviour
 * documented in PROTOCOL.md. It lets us exercise the real fetch stack (headers,
 * Set-Cookie, status codes) without touching the real system.
 */
export async function startFakePortal(options: FakePortalOptions = {}): Promise<FakePortal> {
  const email = options.email ?? "operator@urja.local";
  const password = options.password ?? "correct-horse";
  const maxAgeSeconds = options.maxAgeSeconds ?? 3600;

  const exportMeters = options.exportMeters ?? [];
  const transformerRows = options.transformers ?? [];
  const secretMode = options.secretMode ?? "fixed";
  const maxSkew = options.maxTimestampSkewSeconds ?? 300;
  const FIXED_SECRET = "fixed-secret-0123456789abcdefXYZ";

  const validTokens = new Set<string>();
  const secretByToken = new Map<string, string>();
  const stats: FakePortal["stats"] = {
    logins: 0,
    searchRequests: 0,
    keysRequests: 0,
    exportRequests: [],
    energyRequests: [],
    maxInFlight: 0,
  };
  let down = false;
  let inFlight = 0;
  let rngState = options.chaos?.seed ?? 42;
  const random = () => {
    // mulberry32: tiny seeded PRNG
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const meterById = new Map(exportMeters.map((meter) => [(meter as { meterId: string }).meterId, meter as Record<string, unknown>]));
  const knownMeters = new Set(meterById.keys());
  const energyFor =
    options.energy ?? ((meterId: string) => (knownMeters.has(meterId) ? generateEnergy(meterId) : undefined));
  let forcedEnergyFailure: { status: number; remaining: number } | null = null;
  let forcedExportFailure: { status: number; remaining: number } | null = null;
  let exportTotalOverride: number | null = null;
  let expireAfterKeys = false;
  let tokenCounter = 0;
  let origin = "";
  let forcedFailure: { status: number; remaining: number } | null = null;
  let nextSearchDelayMs = 0;

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      sendJson(response, 500, { error: "internal", message: "fake portal crashed" });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", origin);

    if (down) {
      sendJson(response, 503, { error: "unavailable", message: "portal is down" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/login") {
      // Mimics SvelteKit's CSRF protection for form posts.
      if (request.headers.origin !== origin) {
        sendJson(response, 403, { message: "Cross-site POST form submissions are forbidden" });
        return;
      }
      const form = new URLSearchParams(await readBody(request));
      if (form.get("email") !== email || form.get("password") !== password) {
        sendJson(response, 200, { type: "failure", status: 400 });
        return;
      }
      tokenCounter += 1;
      const token = `token-${tokenCounter}`;
      validTokens.add(token);
      secretByToken.set(token, secretMode === "fixed" ? FIXED_SECRET : `secret-for-${token}-padding00`);
      stats.logins += 1;
      sendJson(
        response,
        200,
        { type: "redirect", status: 303, location: "/meters" },
        {
          "set-cookie": `${COOKIE_NAME}=${token}.sig%3D; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`,
        },
      );
      return;
    }

    // SvelteKit page data for a meter detail page (devalue-encoded), PROTOCOL.md 3.2.
    const pageMatch = /^\/meters\/([^/]+)\/__data\.json$/.exec(url.pathname);
    if (pageMatch !== null) {
      if (!hasValidSession(request)) {
        sendJson(response, 401, { error: "unauthorized", message: "A valid session is required." });
        return;
      }
      const meter = meterById.get(decodeURIComponent(pageMatch[1] ?? ""));
      if (meter === undefined) {
        sendJson(response, 404, { message: "Not Found" });
        return;
      }
      sendJson(response, 200, {
        type: "data",
        nodes: [{ type: "skip" }, { type: "skip" }, { type: "data", data: encodeDevalue(meterPageData(meter as never)), uses: {} }],
      });
      return;
    }

    if (url.pathname.startsWith("/portal/")) {
      inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
      try {
        await handlePortal(request, response, url);
      } finally {
        inFlight -= 1;
      }
      return;
    }

    sendJson(response, 404, { error: "not_found", message: "Not Found" });
  }

  async function handlePortal(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    {
      if (options.chaos !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, Math.floor(random() * options.chaos!.maxLatencyMs)));
        if (random() < options.chaos.failureRate) {
          const status = [500, 502, 503, 429][Math.floor(random() * 4)] ?? 503;
          sendJson(response, status, { error: "chaos", message: "injected failure" });
          return;
        }
      }
      if (!hasValidSession(request)) {
        sendJson(response, 401, { error: "unauthorized", message: "A valid session is required." });
        return;
      }

      if (url.pathname === "/portal/dts") {
        const page = Number(url.searchParams.get("page") ?? 1);
        sendJson(response, 200, {
          data: transformerRows.slice((page - 1) * 20, page * 20),
          total: transformerRows.length,
          page,
          pageSize: 20,
        });
        return;
      }

      if (url.pathname === "/portal/keys") {
        stats.keysRequests += 1;
        sendJson(response, 200, { data: { signingSecret: secretFor(request) } });
        if (expireAfterKeys) {
          expireAfterKeys = false;
          validTokens.clear();
        }
        return;
      }

      if (url.pathname === "/portal/export") {
        const timestamp = header(request, "x-timestamp");
        const signature = header(request, "x-signature");
        const message = ["GET", url.pathname, url.search.replace(/^\?/, ""), timestamp ?? ""].join("\n");
        const expected = createHmac("sha256", secretFor(request)).update(message).digest("hex");
        const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
        const accepted =
          signature !== undefined &&
          signature.length === expected.length &&
          timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) &&
          Number.isFinite(skew) &&
          skew <= maxSkew;
        stats.exportRequests.push({ timestamp, accepted });
        if (!accepted) {
          // Real status for a bad signature is unknown (PROTOCOL.md, section 6); 403 is a guess.
          sendJson(response, 403, { error: "invalid_signature", message: "Signature mismatch" });
          return;
        }
        if (forcedExportFailure !== null && forcedExportFailure.remaining > 0) {
          forcedExportFailure.remaining -= 1;
          sendJson(response, forcedExportFailure.status, { error: "boom", message: "forced failure" });
          return;
        }
        sendJson(response, 200, { data: exportMeters, total: exportTotalOverride ?? exportMeters.length });
        return;
      }

      const energyMatch = /^\/portal\/meters\/([^/]+)\/energy$/.exec(url.pathname);
      if (energyMatch !== null) {
        const meterId = decodeURIComponent(energyMatch[1] ?? "");
        stats.energyRequests.push(`${meterId}${url.search}`);
        if (forcedEnergyFailure !== null && forcedEnergyFailure.remaining > 0) {
          forcedEnergyFailure.remaining -= 1;
          sendJson(response, forcedEnergyFailure.status, { error: "boom", message: "forced failure" });
          return;
        }
        const rows = energyFor(meterId);
        if (rows === undefined) {
          sendJson(response, 404, { error: "not_found", message: "Meter not found" });
          return;
        }
        sendJson(response, 200, { data: filterEnergy(rows, url.searchParams) });
        return;
      }

      if (url.pathname === "/portal/meters/search") {
        stats.searchRequests += 1;
        if (nextSearchDelayMs > 0) {
          const delay = nextSearchDelayMs;
          nextSearchDelayMs = 0;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        if (forcedFailure !== null && forcedFailure.remaining > 0) {
          forcedFailure.remaining -= 1;
          sendJson(response, forcedFailure.status, { error: "boom", message: "forced failure" });
          return;
        }
        const page = Number(url.searchParams.get("page") ?? 1);
        if (meterById.size === 0) {
          // Minimal stub for client tests that do not care about meter data.
          sendJson(response, 200, { data: [{ meterId: "J100000" }, { meterId: "J100001" }], total: 403, page, pageSize: 20 });
          return;
        }
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const matches = [...meterById.values()].filter((m) => String(m.meterId).toLowerCase().includes(q));
        sendJson(response, 200, {
          data: matches.slice((page - 1) * 20, page * 20).map((m) => ({
            meterId: m.meterId,
            serialNo: m.serialNo,
            make: m.make,
            phaseType: m.phaseType,
            installStatus: m.installStatus,
            dtCode: m.dtCode,
          })),
          total: matches.length,
          page,
          pageSize: 20,
        });
        return;
      }

      const geoMatch = /^\/portal\/meters\/([^/]+)\/geo$/.exec(url.pathname);
      if (geoMatch !== null) {
        const meter = meterById.get(decodeURIComponent(geoMatch[1] ?? ""));
        if (meter === undefined) {
          sendJson(response, 404, { error: "not_found", message: "Meter not found" });
          return;
        }
        const geo = meter.geo as { lat: number; lng: number };
        sendJson(response, 200, { data: { latitude: String(geo.lat), longitude: String(geo.lng) } });
        return;
      }

      if (url.pathname === "/portal/meters/not-json") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html>legacy HTML</html>");
        return;
      }

      sendJson(response, 404, { error: "not_found", message: "Meter not found" });
    }
  }

  function sessionToken(request: IncomingMessage): string | undefined {
    const cookieHeader = request.headers.cookie ?? "";
    const match = new RegExp(`${COOKIE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^.;]+)`).exec(
      cookieHeader,
    );
    return match?.[1];
  }

  function hasValidSession(request: IncomingMessage): boolean {
    const token = sessionToken(request);
    return token !== undefined && validTokens.has(token);
  }

  function secretFor(request: IncomingMessage): string {
    const token = sessionToken(request);
    return (token !== undefined && secretByToken.get(token)) || FIXED_SECRET;
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl: origin,
    stats,
    expireAllSessions: () => validTokens.clear(),
    setDown: (value) => {
      down = value;
    },
    failNextSearches: (status, times) => {
      forcedFailure = { status, remaining: times };
    },
    delayNextSearch: (ms) => {
      nextSearchDelayMs = ms;
    },
    failNextEnergy: (status, times) => {
      forcedEnergyFailure = { status, remaining: times };
    },
    failNextExports: (status, times) => {
      forcedExportFailure = { status, remaining: times };
    },
    expireSessionsAfterNextKeys: () => {
      expireAfterKeys = true;
    },
    setExportTotal: (total) => {
      exportTotalOverride = total;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
