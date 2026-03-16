import { fireHook, pipeHook, hooks } from "./hooks.ts";
import { broadcastChange } from "./realtime.ts";
import { validId, real, openTbl, mkTbl, getRows, getAllRows, clean, toFilter, getUser, ok, err, cors } from "./db.ts";

export const handleRest = async (table: string, req: Request, P: Record<string, string>, B: any): Promise<Response> => {
  if (!validId(table)) return err("Invalid table name");

  if (hooks.canAccess) {
    const reqUser = await getUser(req).catch(() => null);
    const denied = await fireHook("canAccess", { user: reqUser, table, method: req.method });
    if (denied) return err(denied, 403);
  }

  const prefer = req.headers.get("Prefer") || "";
  const returnMinimal = prefer.includes("return=minimal");

  if (req.method === "GET") {
    if (P.vec) {
      const t = await openTbl(table);
      if (!t) return ok([]);
      const limit = P.limit ? parseInt(P.limit) : 10;
      const filter = toFilter(P);
      try {
        let q = t.search(JSON.parse(P.vec) as number[]).limit(limit);
        q = q.filter(filter ? `(${real()}) AND (${filter})` : real());
        return ok(clean(await q.execute() as any[]));
      } catch { return err("Invalid vector", 400); }
    }
    const paramsHooked = await pipeHook("beforeSelect", P, table);
    const filter = toFilter(paramsHooked);
    let rows = filter ? await getRows(table, filter) : await getAllRows(table);
    rows = await pipeHook("afterSelect", rows, table);
    if (P.select && P.select !== "*") {
      const cols = P.select.split(",").filter(c => validId(c));
      rows = rows.map((r: any) => Object.fromEntries(cols.map(c => [c, r[c]])));
    }
    if (P.order) {
      const [col, dir] = P.order.split(".");
      if (validId(col)) rows.sort((a: any, b: any) => dir === "desc" ? (b[col] > a[col] ? 1 : -1) : (a[col] > b[col] ? 1 : -1));
    }
    const limit = Math.max(0, parseInt(P.limit) || 1000);
    const offset = Math.max(0, parseInt(P.offset) || 0);
    const page = clean(rows).slice(offset, offset + limit);
    const rangeEnd = page.length ? offset + page.length - 1 : 0;
    const extra: Record<string, string> = {};
    if (P.count === "exact" || prefer.includes("count=exact")) {
      extra["Content-Range"] = page.length ? `${offset}-${rangeEnd}/${rows.length}` : `*`;
      return Response.json({ data: page, error: null, count: rows.length }, { status: 200, headers: { ...cors, ...extra } });
    }
    extra["Content-Range"] = page.length ? `${offset}-${rangeEnd}/*` : `*`;
    return ok(page, 200, extra);
  }

  if (req.method === "POST") {
    let rows = Array.isArray(B) ? B : [B];
    if (!rows.length || !Object.keys(rows[0]).length) return err("Empty body");
    if (Object.keys(rows[0]).some(k => k !== "vector" && !validId(k))) return err("Invalid column name");
    const preErr = await fireHook("beforeInsert", table, rows);
    if (preErr) return err(preErr, 400);
    rows = await pipeHook("afterInsert", rows.map((r: any) => ({ id: r.id ?? crypto.randomUUID(), ...r, vector: r.vector ?? [0] })), table);
    let t = await openTbl(table);
    if (!t) t = await mkTbl(table, rows);
    else await t.add(rows);
    for (const row of clean(rows)) broadcastChange(table, "INSERT", row, null);
    if (returnMinimal) return new Response(null, { status: 204, headers: cors });
    return ok(clean(rows), 201);
  }

  if (req.method === "PUT" || req.method === "PATCH") {
    const filter = toFilter(P);
    if (!filter) return err("No filter provided");
    const t = await openTbl(table);
    if (!t) return err("Table not found", 404);
    const data = Array.isArray(B) ? B[0] : B;
    let existing = await getRows(table, filter);
    if (!existing.length) return ok([]);
    const preErr = await fireHook("beforeUpdate", table, existing, data);
    if (preErr) return err(preErr, 400);
    await t.delete(`(${real()}) AND (${filter})`);
    let updated = existing.map((r: any) => ({ ...r, ...data, vector: r.vector ?? [0] }));
    updated = await pipeHook("afterUpdate", updated, table);
    await t.add(updated);
    for (let i = 0; i < updated.length; i++) broadcastChange(table, "UPDATE", clean([updated[i]])[0], clean([existing[i]])[0]);
    if (returnMinimal) return new Response(null, { status: 204, headers: cors });
    return ok(clean(updated));
  }

  if (req.method === "DELETE") {
    const filter = toFilter(P);
    if (!filter) return err("No filter provided");
    const t = await openTbl(table);
    if (!t) return err("Table not found", 404);
    const toDelete = await getRows(table, filter);
    const preErr = await fireHook("beforeDelete", table, toDelete);
    if (preErr) return err(preErr, 400);
    await t.delete(`(${real()}) AND (${filter})`);
    await fireHook("afterDelete", table, toDelete);
    for (const row of clean(toDelete)) broadcastChange(table, "DELETE", null, row);
    if (returnMinimal) return new Response(null, { status: 204, headers: cors });
    return ok([]);
  }

  return err("Method not allowed", 405);
};
