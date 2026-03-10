const BB = (url: string, key: string) => {
  let token: string | null = null;
  let session: any = null;
  const authListeners: Array<(event: string, session: any) => void> = [];
  const base = url.replace(/\/$/, "");

  const emit = (event: string, s: any) => authListeners.forEach(cb => cb(event, s));

  const req = async (path: string, opts: RequestInit = {}) => {
    const r = await globalThis.fetch(`${base}/${path}`, {
      ...opts,
      headers: { apikey: key, Authorization: `Bearer ${token || key}`, "Content-Type": "application/json", ...opts.headers },
    });
    return r.json();
  };

  // Core query builder — returns { data, error } (Supabase-compatible)
  const Q = (table: string, method?: string, body?: any) => {
    const q = { filters: [] as string[], order: "", limit: 0, offset: 0, select: "*", vec: "", count: "" };
    let _single = false, _maybeSingle = false;

    const qs = () => {
      const p = [`select=${q.select}`, ...q.filters];
      if (q.order) p.push(`order=${q.order}`);
      if (q.limit) p.push(`limit=${q.limit}`);
      if (q.offset) p.push(`offset=${q.offset}`);
      if (q.vec) p.push(`vec=${encodeURIComponent(q.vec)}`);
      if (q.count) p.push(`count=${q.count}`);
      return p.join("&");
    };

    const run = () => method && body !== undefined
      ? req(`rest/v1/${table}?${qs()}`, { method, body: JSON.stringify(body) })
      : req(`rest/v1/${table}?${qs()}`);

    const resolve = async () => {
      const res = await run();
      if (res.error) return res;
      let data = res.data ?? res;
      if (_single) {
        if (!data?.length) return { data: null, error: { message: "No rows found", code: 406 } };
        return { data: data[0], error: null };
      }
      if (_maybeSingle) return { data: data?.[0] ?? null, error: null };
      return { data, error: null, ...(res.count !== undefined ? { count: res.count } : {}) };
    };

    const b: any = {
      select:      (cols = "*") => (q.select = cols, b),
      eq:          (col: string, val: any) => (q.filters.push(`eq.${col}=${val}`), b),
      neq:         (col: string, val: any) => (q.filters.push(`neq.${col}=${val}`), b),
      gt:          (col: string, val: any) => (q.filters.push(`gt.${col}=${val}`), b),
      gte:         (col: string, val: any) => (q.filters.push(`gte.${col}=${val}`), b),
      lt:          (col: string, val: any) => (q.filters.push(`lt.${col}=${val}`), b),
      lte:         (col: string, val: any) => (q.filters.push(`lte.${col}=${val}`), b),
      like:        (col: string, val: any) => (q.filters.push(`like.${col}=${val}`), b),
      ilike:       (col: string, val: any) => (q.filters.push(`ilike.${col}=${val}`), b),
      is:          (col: string, val: any) => (q.filters.push(`is.${col}=${val}`), b),
      in:          (col: string, vals: any[]) => (q.filters.push(`in.${col}=${vals.join(",")}`), b),
      not:         (col: string, _op: string, val: any) => (q.filters.push(`not.${col}=${val}`), b),
      or:          (clause: string) => (q.filters.push(`or=${clause}`), b),
      order:       (col: string, { ascending = true } = {}) => (q.order = `${col}.${ascending ? "asc" : "desc"}`, b),
      limit:       (n: number) => (q.limit = n, b),
      offset:      (n: number) => (q.offset = n, b),
      range:       (from: number, to: number) => (q.limit = to - from + 1, q.offset = from, b),
      // count — add Prefer header equivalent via query param
      count:       (type: "exact" | "planned" | "estimated" = "exact") => (q.count = type, b),
      single:      () => (_single = true, b),
      maybeSingle: () => (_maybeSingle = true, b),
      // Vector similarity search
      vec:         (embedding: number[], limit = 10) => (q.vec = JSON.stringify(embedding), q.limit = limit, b),
      then:        (res: any, rej: any) => resolve().then(res, rej),
    };
    return b;
  };

  const from = (table: string) => ({
    select:  (cols = "*") => Q(table).select(cols),
    insert:  (data: any, opts: any = {}) => req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]) })
                .then((r: any) => r.error ? r : { data: r.data ?? r, error: null }),
    upsert:  (data: any) => req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]) })
                .then((r: any) => r.error ? r : { data: r.data ?? r, error: null }),
    update:  (data: any) => Q(table, "PATCH", data),
    delete:  () => Q(table, "DELETE", null),
  });

  // Auth — Supabase v2 compatible method names
  const auth = {
    signUp: ({ email, password, options }: { email: string; password: string; options?: any }) =>
      req("auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password, data: options?.data }) })
        .then((r: any) => r.error ? r : (() => { if (r.data?.session?.access_token) { token = r.data.session.access_token; session = r.data.session; emit("SIGNED_IN", session); } return r; })()),

    signInWithPassword: ({ email, password }: { email: string; password: string }) =>
      req("auth/v1/token", { method: "POST", body: JSON.stringify({ email, password }) })
        .then((r: any) => r.error ? r : (() => { if (r.data?.session?.access_token) { token = r.data.session.access_token; session = r.data.session; emit("SIGNED_IN", session); } return r; })()),

    // Keep old signIn as alias
    signIn: ({ email, password }: { email: string; password: string }) => auth.signInWithPassword({ email, password }),

    signOut: () =>
      req("auth/v1/logout", { method: "POST" })
        .then((r: any) => { token = null; session = null; emit("SIGNED_OUT", null); return r; }),

    getUser: () => req("auth/v1/user"),

    getSession: () => Promise.resolve({ data: { session }, error: null }),

    updateUser: (attrs: { email?: string; password?: string; data?: any }) =>
      req("auth/v1/update", { method: "PATCH", body: JSON.stringify(attrs) }),

    onAuthStateChange: (cb: (event: string, session: any) => void) => {
      authListeners.push(cb);
      // Fire INITIAL_SESSION immediately
      cb("INITIAL_SESSION", session);
      return { data: { subscription: { unsubscribe: () => { const i = authListeners.indexOf(cb); if (i > -1) authListeners.splice(i, 1); } } } };
    },
  };

  return { from, auth };
};

export { BB as createClient };
export default BB;
