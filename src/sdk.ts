const BB = (url: string, key: string) => {
  let token: string | null = null;
  const baseUrl = url.replace(/\/$/, "");

  const req = (path: string, opts: RequestInit = {}) =>
    globalThis.fetch(`${baseUrl}/${path}`, {
      ...opts,
      headers: { apikey: key, Authorization: `Bearer ${token || key}`, ...opts.headers }
    }).then(r => r.json());

  const Q = (table: string, method?: string, body?: any) => {
    const q: { filters: string[], order: string, limit: number, offset: number, select: string, range?: string } = {
      filters: [], order: "", limit: 1000, offset: 0, select: "*"
    };

    const execute = () => {
      const params = [`select=${q.select}`, ...q.filters];
      if (q.order) params.push(`order=${q.order}`);
      params.push(`limit=${q.limit}`, `offset=${q.offset}`);
      if (q.range) params.push(`range=${q.range}`);
      const qs = params.join("&");
      if (method && body !== undefined) {
        return req(`rest/v1/${table}?${qs}`, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      }
      return req(`rest/v1/${table}?${qs}`);
    };

    const builder: any = {
      select: (cols = "*") => (q.select = cols, builder),
      eq: (col: string, val: any) => (q.filters.push(`eq.${col}=${val}`), builder),
      neq: (col: string, val: any) => (q.filters.push(`neq.${col}=${val}`), builder),
      gt: (col: string, val: any) => (q.filters.push(`gt.${col}=${val}`), builder),
      gte: (col: string, val: any) => (q.filters.push(`gte.${col}=${val}`), builder),
      lt: (col: string, val: any) => (q.filters.push(`lt.${col}=${val}`), builder),
      lte: (col: string, val: any) => (q.filters.push(`lte.${col}=${val}`), builder),
      like: (col: string, val: any) => (q.filters.push(`like.${col}=${val}`), builder),
      ilike: (col: string, val: any) => (q.filters.push(`ilike.${col}=${val}`), builder),
      order: (col: string, { ascending = true } = {}) => (q.order = `${col}.${ascending ? "asc" : "desc"}`, builder),
      limit: (n: number) => (q.limit = n, builder),
      offset: (n: number) => (q.offset = n, builder),
      range: (from: number, to: number) => (q.range = `${from},${to}`, builder),
      then: (resolve: any, reject: any) => execute().then(resolve, reject)
    };
    return builder;
  };

  const from = (table: string) => ({
    select: (cols = "*") => Q(table).select(cols),
    insert: (data: any) => req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]), headers: { "Content-Type": "application/json" } }),
    upsert: (data: any) => {
      // upsert: try insert, on conflict update — send as POST with conflict hint
      return req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]), headers: { "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" } });
    },
    update: (data: any) => Q(table, "PATCH", data),
    delete: () => Q(table, "DELETE", null)
  });

  return {
    from,
    auth: {
      signUp: (email: string, password: string) =>
        req("auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password }), headers: { "Content-Type": "application/json" } }),
      signIn: (email: string, password: string) =>
        req("auth/v1/token", { method: "POST", body: JSON.stringify({ email, password }), headers: { "Content-Type": "application/json" } })
          .then((r: any) => { if (r.access_token) token = r.access_token; return r; }),
      signOut: () =>
        req("auth/v1/logout", { method: "POST" }).then(() => { token = null; return {}; }),
      getUser: () => req("auth/v1/user")
    }
  };
};

export { BB as createClient };
export default BB;
