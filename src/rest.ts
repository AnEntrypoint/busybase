import type { Client } from "@libsql/client";
import { fireHook, pipeHook, hooks } from "./hooks.ts";
import { broadcastChange } from "./realtime.ts";
import { validId, openTblIn, ensureTableIn, dbInsertIn, dbUpdateIn, dbDeleteIn, getRowsIn, getAllRowsIn, clean, toFilter, getUserFromRequestIn, ok, err, cors, db as defaultDb, vecSearch, makeRateLimiter, getTableColumnsIn, tableExistsIn } from "./db.ts";

export type BroadcastFn = (table: string, eventType: "INSERT" | "UPDATE" | "DELETE", newRow: any, oldRow: any) => void;

export const restRateLimiter = makeRateLimiter(60_000, 300);

export const handleRest = async (client: Client, table: string, req: Request, P: Record<string, string>, B: any, broadcast: BroadcastFn = broadcastChange, ip = "unknown"): Promise<Response> => {
  if (!validId(table)) return err("Invalid table name");

  const isMutating = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
  if (isMutating && restRateLimiter.limited(ip)) return err("Too many requests, please try again later", 429);

  if (hooks.canAccess) {
    const reqUser = await getUserFromRequestIn(client, req).catch(() => null);
    const denied = await fireHook("canAccess", { user: reqUser, table, method: req.method });
    if (denied) return err(denied, 403);
  }

  const prefer = req.headers.get("Prefer") || "";
  const returnMinimal = prefer.includes("return=minimal");

  if (req.method === "GET") {
    const paramsHooked = await pipeHook("beforeSelect", P, table);
    const filter = toFilter(paramsHooked);
    let rows = filter ? await getRowsIn(client, table, filter) : await getAllRowsIn(client, table);
    rows = await pipeHook("afterSelect", rows, table);

    let isVecSearch = false;
    if (paramsHooked.vec) {
      let embedding: unknown;
      try { embedding = JSON.parse(paramsHooked.vec); } catch { return err("Invalid vec: must be a JSON array of numbers"); }
      if (!Array.isArray(embedding) || !embedding.every(n => typeof n === "number")) return err("Invalid vec: must be a JSON array of numbers");
      isVecSearch = true;
      rows = vecSearch(rows, embedding, Math.max(0, parseInt(paramsHooked.limit) || 10));
    }

    let knownCols = rows.length ? new Set(Object.keys(rows[0])) : null;
    if (!knownCols && (paramsHooked.select && paramsHooked.select !== "*" || paramsHooked.order) && await tableExistsIn(client, table)) {
      knownCols = await getTableColumnsIn(client, table);
    }
    if (paramsHooked.select && paramsHooked.select !== "*") {
      const requested = paramsHooked.select.split(",");
      const invalidSyntax = requested.filter(c => !validId(c) && c !== "_distance");
      if (invalidSyntax.length) return err(`Invalid column name in select: ${invalidSyntax.join(", ")}`);
      const unknown = knownCols ? requested.filter(c => !knownCols!.has(c) && c !== "_distance") : [];
      if (unknown.length) return err(`Unknown column in select: ${unknown.join(", ")}`);
      rows = rows.map((r: any) => Object.fromEntries(requested.map(c => [c, r[c]])));
    }
    if (paramsHooked.order) {
      const [col, dir] = paramsHooked.order.split(".");
      if (!validId(col) && col !== "_distance") return err(`Invalid column name in order: ${col}`);
      if (knownCols && !knownCols.has(col) && col !== "_distance") return err(`Unknown column in order: ${col}`);
      const numCmp = (x: any, y: any) => {
        const nx = Number(x), ny = Number(y);
        if (x !== "" && x != null && y !== "" && y != null && Number.isFinite(nx) && Number.isFinite(ny)) return nx - ny;
        return x > y ? 1 : x < y ? -1 : 0;
      };
      rows.sort((a: any, b: any) => dir === "desc" ? numCmp(b[col], a[col]) : numCmp(a[col], b[col]));
    }
    const limit = isVecSearch ? rows.length : Math.max(0, parseInt(paramsHooked.limit) || 1000);
    const offset = isVecSearch ? 0 : Math.max(0, parseInt(paramsHooked.offset) || 0);
    const page = clean(rows).slice(offset, offset + limit);
    const rangeEnd = page.length ? offset + page.length - 1 : 0;
    const extra: Record<string, string> = {};
    if (paramsHooked.count === "exact" || prefer.includes("count=exact")) {
      extra["Content-Range"] = page.length ? `${offset}-${rangeEnd}/${rows.length}` : `*`;
      return Response.json({ data: page, error: null, count: rows.length }, { status: 200, headers: { ...cors, ...extra } });
    }
    extra["Content-Range"] = page.length ? `${offset}-${rangeEnd}/*` : `*`;
    return ok(page, 200, extra);
  }

  if (req.method === "POST") {
    let rows = Array.isArray(B) ? B : [B];
    if (!rows.length || !Object.keys(rows[0]).length) return err("Empty body");
    if (Object.keys(rows[0]).some(k => !validId(k))) return err("Invalid column name");
    const preErr = await fireHook("beforeInsert", table, rows);
    if (preErr) return err(preErr, 400);
    rows = await pipeHook("afterInsert", rows.map((r: any) => ({ id: r.id ?? crypto.randomUUID(), ...r })), table);
    await ensureTableIn(client, table, rows[0]);
    for (const row of rows) await dbInsertIn(client, table, row);
    for (const row of clean(rows)) broadcast(table, "INSERT", row, null);
    if (returnMinimal) return new Response(null, { status: 204, headers: cors });
    return ok(clean(rows), 201);
  }

  if (req.method === "PUT" || req.method === "PATCH") {
    const filter = toFilter(P);
    if (!filter) return err("No filter provided");
    if (!(await openTblIn(client, table))) return err("Table not found", 404);
    if (Array.isArray(B)) return err("Array body not supported for PUT/PATCH; update rows individually or by id");
    const data = B;
    let existing = await getRowsIn(client, table, filter);
    if (!existing.length) return ok([]);
    const preErr = await fireHook("beforeUpdate", table, existing, data);
    if (preErr) return err(preErr, 400);
    await dbUpdateIn(client, table, data, filter);
    let updated = existing.map((r: any) => ({ ...r, ...data }));
    updated = await pipeHook("afterUpdate", updated, table);
    for (let i = 0; i < updated.length; i++) broadcast(table, "UPDATE", clean([updated[i]])[0], clean([existing[i]])[0]);
    if (returnMinimal) return new Response(null, { status: 204, headers: cors });
    return ok(clean(updated));
  }

  if (req.method === "DELETE") {
    const filter = toFilter(P);
    if (!filter) return err("No filter provided");
    if (!(await openTblIn(client, table))) return err("Table not found", 404);
    const toDelete = await getRowsIn(client, table, filter);
    const preErr = await fireHook("beforeDelete", table, toDelete);
    if (preErr) return err(preErr, 400);
    await dbDeleteIn(client, table, filter);
    await fireHook("afterDelete", table, toDelete);
    for (const row of clean(toDelete)) broadcast(table, "DELETE", null, row);
    if (returnMinimal) return new Response(null, { status: 204, headers: cors });
    return ok([]);
  }

  return err("Method not allowed", 405);
};

// Convenience wrapper for the HTTP server, bound to the module-level singleton client.
export const handleRestDefault = (table: string, req: Request, P: Record<string, string>, B: any, ip = "unknown") =>
  handleRest(defaultDb, table, req, P, B, broadcastChange, ip);
