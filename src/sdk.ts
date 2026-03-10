const BB = (url: string, key: string) => {
  let token: string | null = null;
  const base = url.replace(/\/$/, "");

  const req = (path: string, opts: RequestInit = {}) =>
    globalThis.fetch(`${base}/${path}`, {
      ...opts,
      headers: { apikey: key, Authorization: `Bearer ${token || key}`, ...opts.headers }
    }).then(r => r.json());

  const Q = (table: string, method?: string, body?: any) => {
    const q = { filters: [] as string[], order: "", limit: 0, offset: 0, select: "*", vec: "" };

    const qs = () => {
      const p = [`select=${q.select}`, ...q.filters];
      if (q.order) p.push(`order=${q.order}`);
      if (q.limit) p.push(`limit=${q.limit}`);
      if (q.offset) p.push(`offset=${q.offset}`);
      if (q.vec) p.push(`vec=${encodeURIComponent(q.vec)}`);
      return p.join("&");
    };

    const run = () => method && body !== undefined
      ? req(`rest/v1/${table}?${qs()}`, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })
      : req(`rest/v1/${table}?${qs()}`);

    const b: any = {
      select: (cols = "*") => (q.select = cols, b),
      eq:     (col: string, val: any) => (q.filters.push(`eq.${col}=${val}`), b),
      neq:    (col: string, val: any) => (q.filters.push(`neq.${col}=${val}`), b),
      gt:     (col: string, val: any) => (q.filters.push(`gt.${col}=${val}`), b),
      gte:    (col: string, val: any) => (q.filters.push(`gte.${col}=${val}`), b),
      lt:     (col: string, val: any) => (q.filters.push(`lt.${col}=${val}`), b),
      lte:    (col: string, val: any) => (q.filters.push(`lte.${col}=${val}`), b),
      like:   (col: string, val: any) => (q.filters.push(`like.${col}=${val}`), b),
      ilike:  (col: string, val: any) => (q.filters.push(`ilike.${col}=${val}`), b),
      order:  (col: string, { ascending = true } = {}) => (q.order = `${col}.${ascending ? "asc" : "desc"}`, b),
      limit:  (n: number) => (q.limit = n, b),
      offset: (n: number) => (q.offset = n, b),
      range:  (from: number, to: number) => (q.limit = to - from + 1, q.offset = from, b),
      // Vector search: pass embedding array, returns rows sorted by similarity with _distance
      vec:    (embedding: number[], limit = 10) => (q.vec = JSON.stringify(embedding), q.limit = limit, b),
      then:   (resolve: any, reject: any) => run().then(resolve, reject),
    };
    return b;
  };

  const from = (table: string) => ({
    select: (cols = "*") => Q(table).select(cols),
    insert: (data: any) => req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]), headers: { "Content-Type": "application/json" } }),
    upsert: (data: any) => req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]), headers: { "Content-Type": "application/json" } }),
    update: (data: any) => Q(table, "PATCH", data),
    delete: () => Q(table, "DELETE", null),
  });

  return {
    from,
    auth: {
      signUp:  (email: string, password: string) => req("auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password }), headers: { "Content-Type": "application/json" } }),
      signIn:  (email: string, password: string) => req("auth/v1/token",  { method: "POST", body: JSON.stringify({ email, password }), headers: { "Content-Type": "application/json" } }).then((r: any) => { if (r.access_token) token = r.access_token; return r; }),
      signOut: () => req("auth/v1/logout", { method: "POST" }).then(() => { token = null; return {}; }),
      getUser: () => req("auth/v1/user"),
    },
  };
};

export { BB as createClient };
export default BB;
