// src/sdk.ts
var BB = (url, key) => {
  let token = null;
  const baseUrl = url.replace(/\/$/, "");
  const req = (path, opts = {}) => globalThis.fetch(`${baseUrl}/${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${token || key}`, ...opts.headers }
  }).then((r) => r.json());
  const Q = (table, method, body) => {
    const q = {
      filters: [],
      order: "",
      limit: 1000,
      offset: 0,
      select: "*"
    };
    const execute = () => {
      const params = [`select=${q.select}`, ...q.filters];
      if (q.order)
        params.push(`order=${q.order}`);
      params.push(`limit=${q.limit}`, `offset=${q.offset}`);
      if (q.range)
        params.push(`range=${q.range}`);
      const qs = params.join("&");
      if (method && body !== undefined) {
        return req(`rest/v1/${table}?${qs}`, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      }
      return req(`rest/v1/${table}?${qs}`);
    };
    const builder = {
      select: (cols = "*") => (q.select = cols, builder),
      eq: (col, val) => (q.filters.push(`eq.${col}=${val}`), builder),
      neq: (col, val) => (q.filters.push(`neq.${col}=${val}`), builder),
      gt: (col, val) => (q.filters.push(`gt.${col}=${val}`), builder),
      gte: (col, val) => (q.filters.push(`gte.${col}=${val}`), builder),
      lt: (col, val) => (q.filters.push(`lt.${col}=${val}`), builder),
      lte: (col, val) => (q.filters.push(`lte.${col}=${val}`), builder),
      like: (col, val) => (q.filters.push(`like.${col}=${val}`), builder),
      ilike: (col, val) => (q.filters.push(`ilike.${col}=${val}`), builder),
      order: (col, { ascending = true } = {}) => (q.order = `${col}.${ascending ? "asc" : "desc"}`, builder),
      limit: (n) => (q.limit = n, builder),
      offset: (n) => (q.offset = n, builder),
      range: (from2, to) => (q.range = `${from2},${to}`, builder),
      then: (resolve, reject) => execute().then(resolve, reject)
    };
    return builder;
  };
  const from = (table) => ({
    select: (cols = "*") => Q(table).select(cols),
    insert: (data) => req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]), headers: { "Content-Type": "application/json" } }),
    upsert: (data) => {
      return req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]), headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" } });
    },
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
