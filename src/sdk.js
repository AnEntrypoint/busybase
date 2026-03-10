// src/sdk.ts
var BB = (url, key) => {
  let token = null;
  let session = null;
  const authListeners = [];
  const base = url.replace(/\/$/, "");
  const emit = (event, s) => authListeners.forEach((cb) => cb(event, s));
  const req = async (path, opts = {}) => {
    const r = await globalThis.fetch(`${base}/${path}`, {
      ...opts,
      headers: { apikey: key, Authorization: `Bearer ${token || key}`, "Content-Type": "application/json", ...opts.headers }
    });
    return r.json();
  };
  const Q = (table, method, body) => {
    const q = { filters: [], order: "", limit: 0, offset: 0, select: "*", vec: "", count: "" };
    let _single = false, _maybeSingle = false;
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
      if (q.count)
        p.push(`count=${q.count}`);
      return p.join("&");
    };
    const run = () => method && body !== undefined ? req(`rest/v1/${table}?${qs()}`, { method, body: JSON.stringify(body) }) : req(`rest/v1/${table}?${qs()}`);
    const resolve = async () => {
      const res = await run();
      if (res.error)
        return res;
      let data = res.data ?? res;
      if (_single) {
        if (!data?.length)
          return { data: null, error: { message: "No rows found", code: 406 } };
        return { data: data[0], error: null };
      }
      if (_maybeSingle)
        return { data: data?.[0] ?? null, error: null };
      return { data, error: null, ...res.count !== undefined ? { count: res.count } : {} };
    };
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
      is: (col, val) => (q.filters.push(`is.${col}=${val}`), b),
      in: (col, vals) => (q.filters.push(`in.${col}=${vals.join(",")}`), b),
      not: (col, _op, val) => (q.filters.push(`not.${col}=${val}`), b),
      or: (clause) => (q.filters.push(`or=${clause}`), b),
      order: (col, { ascending = true } = {}) => (q.order = `${col}.${ascending ? "asc" : "desc"}`, b),
      limit: (n) => (q.limit = n, b),
      offset: (n) => (q.offset = n, b),
      range: (from2, to) => (q.limit = to - from2 + 1, q.offset = from2, b),
      count: (type = "exact") => (q.count = type, b),
      single: () => (_single = true, b),
      maybeSingle: () => (_maybeSingle = true, b),
      vec: (embedding, limit = 10) => (q.vec = JSON.stringify(embedding), q.limit = limit, b),
      then: (res, rej) => resolve().then(res, rej)
    };
    return b;
  };
  const from = (table) => ({
    select: (cols = "*") => Q(table).select(cols),
    insert: (data, opts = {}) => req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]) }).then((r) => r.error ? r : { data: r.data ?? r, error: null }),
    upsert: (data) => req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]) }).then((r) => r.error ? r : { data: r.data ?? r, error: null }),
    update: (data) => Q(table, "PATCH", data),
    delete: () => Q(table, "DELETE", null)
  });
  const auth = {
    signUp: ({ email, password, options }) => req("auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password, data: options?.data }) }).then((r) => r.error ? r : (() => {
      if (r.data?.session?.access_token) {
        token = r.data.session.access_token;
        session = r.data.session;
        emit("SIGNED_IN", session);
      }
      return r;
    })()),
    signInWithPassword: ({ email, password }) => req("auth/v1/token", { method: "POST", body: JSON.stringify({ email, password }) }).then((r) => r.error ? r : (() => {
      if (r.data?.session?.access_token) {
        token = r.data.session.access_token;
        session = r.data.session;
        emit("SIGNED_IN", session);
      }
      return r;
    })()),
    signIn: ({ email, password }) => auth.signInWithPassword({ email, password }),
    signOut: () => req("auth/v1/logout", { method: "POST" }).then((r) => {
      token = null;
      session = null;
      emit("SIGNED_OUT", null);
      return r;
    }),
    getUser: () => req("auth/v1/user"),
    getSession: () => Promise.resolve({ data: { session }, error: null }),
    updateUser: (attrs) => req("auth/v1/update", { method: "PATCH", body: JSON.stringify(attrs) }),
    onAuthStateChange: (cb) => {
      authListeners.push(cb);
      cb("INITIAL_SESSION", session);
      return { data: { subscription: { unsubscribe: () => {
        const i = authListeners.indexOf(cb);
        if (i > -1)
          authListeners.splice(i, 1);
      } } } };
    }
  };
  return { from, auth };
};
var sdk_default = BB;
export {
  sdk_default as default,
  BB as createClient
};
