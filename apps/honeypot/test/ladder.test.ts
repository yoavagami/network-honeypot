import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { applyLadder, injectLadder, mintPageLoadId, registerLadderRoutes, LADDER_ID_RE } from "../src/sensing/ladder.js";

const DOC = `<!doctype html><html><head><title>x</title></head><body><p>hi</p></body></html>`;

describe("rendering ladder markup", () => {
  it("mints ids the beacon routes accept", () => {
    const id = mintPageLoadId();
    expect(id).toMatch(LADDER_ID_RE);
    expect(mintPageLoadId()).not.toBe(id);
  });

  it("adds the meta id, CSS beacon and noscript image to a full document", () => {
    const out = injectLadder(DOC, "abcdefghijklmnopqrst")!;
    expect(out).toContain(`<meta name="request-id" content="abcdefghijklmnopqrst" />`);
    expect(out).toMatch(/\.vh-anchor\{[^}]*background:url\(\/assets\/img\/bg\/abcdefghijklmnopqrst\.png\)/);
    expect(out).toMatch(/<noscript><img src="\/assets\/img\/px\/abcdefghijklmnopqrst\.gif"/);
    expect(out.indexOf("request-id")).toBeLessThan(out.indexOf("</head>"));
    expect(out.indexOf("<noscript>")).toBeLessThan(out.indexOf("</body>"));
    // never display:none — browsers skip background images of elements without a box
    expect(out).not.toMatch(/vh-anchor\{[^}]*display:none/);
  });

  it("leaves fragments alone", () => {
    expect(injectLadder("<html><body><h1>ok</h1></body></html>", "abcdefghijklmnopqrst")).toBeNull();
  });

  it("only touches HTML responses and records the id on the request", () => {
    const request: any = { hp: {} };
    const html: any = { getHeader: () => "text/html; charset=utf-8" };
    const json: any = { getHeader: () => "application/json" };
    expect(applyLadder(request, json, DOC)).toBe(DOC);
    expect(request.hp.pageLoadId).toBeUndefined();
    const out = applyLadder(request, html, DOC) as string;
    expect(request.hp.pageLoadId).toMatch(LADDER_ID_RE);
    expect(out).toContain(request.hp.pageLoadId);
  });
});

describe("rendering ladder beacons", () => {
  async function app() {
    const rows: any[] = [];
    const a = Fastify();
    a.addHook("onRequest", async (request) => {
      (request as any).hp = { actorId: "00000000-0000-0000-0000-000000000001", sessionId: "s", visitorId: "v", labLabel: null };
    });
    registerLadderRoutes(a, { enqueue: (i: any) => rows.push(i) } as any);
    await a.ready();
    return { a, rows };
  }

  it("stores each rung under the page-load id and returns an uncacheable image", async () => {
    const { a, rows } = await app();
    const id = "abcdefghijklmnopqrst";
    for (const [dir, ext, type] of [["bg", "png", "image/png"], ["px", "gif", "image/gif"], ["sp", "gif", "image/gif"]]) {
      const r = await a.inject({ method: "GET", url: `/assets/img/${dir}/${id}.${ext}` });
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toBe(type);
      expect(r.headers["cache-control"]).toBe("no-store");
    }
    expect(rows.map((x) => [x.kind, x.row.kind, x.row.pageLoadId, x.row.data.rung])).toEqual([
      ["client_signals", "ladder", id, "css"],
      ["client_signals", "ladder", id, "noscript"],
      ["client_signals", "ladder", id, "js"],
    ]);
  });

  it("rejects malformed ids and wrong extensions without storing anything", async () => {
    const { a, rows } = await app();
    expect((await a.inject({ method: "GET", url: "/assets/img/bg/short.png" })).statusCode).toBe(404);
    expect((await a.inject({ method: "GET", url: "/assets/img/bg/abcdefghijklmnopqrst.gif" })).statusCode).toBe(404);
    expect(rows).toHaveLength(0);
  });
});
