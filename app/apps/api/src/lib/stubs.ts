import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** Registers every OpenAPI path not already implemented as a 501 that names the PRD section/ticket, so clients can integrate against the full contract. */
export function registerStubs(app: FastifyInstance, specPath: string) {
  const spec = parse(readFileSync(specPath, "utf8"));
  const have = new Set(app.printRoutes({ commonPrefix: false }).split("\n").map((l) => l.trim()));
  let n = 0;
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    const fpath = "/api/v1" + path.replace(/\{(\w+)\}/g, ":$1");
    for (const m of ["get", "post", "put", "patch", "delete"]) {
      if (!item[m]) continue;
      if (app.hasRoute({ method: m.toUpperCase() as any, url: fpath })) continue;
      app.route({ method: m.toUpperCase() as any, url: fpath, handler: async (_req, reply) => reply.code(501).send({ type: "https://familyoffice/errors/not-implemented", title: "Not implemented yet", status: 501, detail: `${m.toUpperCase()} ${path}: ${item[m].summary ?? item[m].tags?.[0] ?? ""} — see api/openapi.yaml and the ticket breakdown` }) });
      n++;
    }
  }
  app.log.info({ stubbed: n }, "OpenAPI stub routes registered");
}
