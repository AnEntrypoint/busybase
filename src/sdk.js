// src/sdk.ts
var BB = (url, key) => {
  let token = null;
  const base = url.replace(/\/$/, "");
  const req = (path, opts = {}) => globalThis.fetch(`${base}/${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${token || key}`, ...opts.headers }
  }).then((r) => r.json());
  const Q = (table, method, body) => {
    const q = { filters: [], order: "", limit: 0, offset: 0, select: "*", vec: "" };
    const qs = () => {
      const p = [`select=${q.select}`, ...q.filters];
      if (q.order)
        p.push(`order=${q.order}`);
      if (q.limit)
        p.push(`limit=${q.limit}`);
      if (q.offset)
        p.push(`offset=${q.offset}`);
      if (q.vec)
        p.push(`vec=${encodeURIComponent(q.vec)}`);
      return p.join("&");
    };
    const run = () => method && body !== undefined ? req(`rest/v1/${table}?${qs()}`, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) : req(`rest/v1/${table}?${qs()}`);
    const b = {
      select: (cols = "*") => (q.select = cols, b),
      eq: (col, val) => (q.filters.push(`eq.${col}=${val}`), b),
      neq: (col, val) => (q.filters.push(`neq.${col}=${val}`), b),
      gt: (col, val) => (q.filters.push(`gt.${col}=${val}`), b),
      gte: (col, val) => (q.filters.push(`gte.${col}=${val}`), b),
      lt: (col, val) => (q.filters.push(`lt.${col}=${val}`), b),
      lte: (col, val) => (q.filters.push(`lte.${col}=${val}`), b),
      like: (col, val) => (q.filters.push(`like.${col}=${val}`), b),
      ilike: (col, val) => (q.filters.push(`ilike.${col}=${val}`), b),
      order: (col, { ascending = true } = {}) => (q.order = `${col}.${ascending ? "asc" : "desc"}`, b),
      limit: (n) => (q.limit = n, b),
      offset: (n) => (q.offset = n, b),
      range: (from2, to) => (q.limit = to - from2 + 1, q.offset = from2, b),
      vec: (embedding, limit = 10) => (q.vec = JSON.stringify(embedding), q.limit = limit, b),
      then: (resolve, reject) => run().then(resolve, reject)
    };
    return b;
  };
  const from = (table) => ({
    select: (cols = "*") => Q(table).select(cols),
    insert: (data) => req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]), headers: { "Content-Type": "application/json" } }),
    upsert: (data) => req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]), headers: { "Content-Type": "application/json" } }),
    update: (data) => Q(table, "PATCH", data),
    delete: () => Q(table, "DELETE", null)
  });
  return {
    from,
    auth: {
      signUp: (email, password) => req("auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password }), headers: { "Content-Type": "application/json" } }),
      signIn: (email, password) => req("auth/v1/token", { method: "POST", body: JSON.stringify({ email, password }), headers: { "Content-Type": "application/json" } }).then((r) => {
        if (r.access_token)
          token = r.access_token;
        return r;
      }),
      signOut: () => req("auth/v1/logout", { method: "POST" }).then(() => {
        token = null;
        return {};
      }),
      getUser: () => req("auth/v1/user")
    }
  };
};
var sdk_default = BB;
export {
  sdk_default as default,
  BB as createClient
};
