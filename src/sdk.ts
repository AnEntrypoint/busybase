// Ed25519 helpers — uses Web Crypto API (built into Bun + all modern browsers, zero deps)
const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

const genKeypair = async () => {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const [pub, priv] = await Promise.all([
    crypto.subtle.exportKey("raw", kp.publicKey),
    crypto.subtle.exportKey("pkcs8", kp.privateKey),
  ]);
  return { pubkey: b64(pub), privkey: b64(priv) };
};

const sign = async (privkeyB64: string, message: string) => {
  const key = await crypto.subtle.importKey("pkcs8", unb64(privkeyB64), { name: "Ed25519" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(message)));
};

// Storage abstraction — localStorage in browser, instance-scoped map in Node/Bun
const makeStore = () => {
  try { localStorage.setItem("_bb_", "1"); localStorage.removeItem("_bb_"); return localStorage; }
  catch { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => m.set(k, v), removeItem: (k: string) => m.delete(k) }; }
};

const BB = (url: string, key: string) => {
  let token: string | null = null;
  let session: any = null;
  const authListeners: Array<(event: string, session: any) => void> = [];
  const base = url.replace(/\/$/, "");
  const store = makeStore();

  const emit = (event: string, s: any) => authListeners.forEach(cb => cb(event, s));
  const setSession_ = (s: any) => { session = s; token = s?.access_token ?? null; };

  const req = async (path: string, opts: RequestInit = {}) => {
    const r = await globalThis.fetch(`${base}/${path}`, {
      ...opts,
      headers: { apikey: key, Authorization: `Bearer ${token || key}`, "Content-Type": "application/json", ...opts.headers },
    });
    return r.json();
  };

  // --- Keypair auth (anonymous-first) ---
  const keypair = {
    // Generate a new keypair and return the privkey (the "backup key")
    generate: genKeypair,

    // Sign in with an existing private key (or a freshly generated one)
    signIn: async (privkeyB64?: string): Promise<any> => {
      let privkey = privkeyB64 ?? store.getItem("_bb_privkey");
      let pubkey = store.getItem("_bb_pubkey");

      if (!privkey) {
        // First time — generate, persist
        const kp = await genKeypair();
        privkey = kp.privkey;
        pubkey = kp.pubkey;
        store.setItem("_bb_privkey", privkey);
        store.setItem("_bb_pubkey", pubkey);
      } else if (!pubkey) {
        // Have privkey from restore, need to derive pubkey
        // Re-import and re-export to get raw public key
        const privCrypto = await crypto.subtle.importKey("pkcs8", unb64(privkey), { name: "Ed25519" }, true, ["sign"]);
        // Can't directly export public from private in WebCrypto — generate pair is the only way
        // So we store pubkey alongside privkey; if missing, user must re-generate
        return { data: null, error: { message: "Pubkey missing — call keypair.restore(privkey, pubkey)" } };
      }

      // Get nonce
      const nonceRes = await req("auth/v1/keypair");
      if (nonceRes.error) return nonceRes;
      const nonce = nonceRes.data.nonce;

      // Sign nonce
      const signature = await sign(privkey, nonce);
      const r = await req("auth/v1/keypair", { method: "POST", body: JSON.stringify({ pubkey, nonce, signature }) });
      if (r.data?.session) { setSession_(r.data.session); store.setItem("_bb_privkey", privkey); store.setItem("_bb_pubkey", pubkey!); emit("SIGNED_IN", session); }
      return r;
    },

    // Restore from a saved backup key (privkey + pubkey pair)
    restore: async (privkey: string, pubkey: string): Promise<any> => {
      store.setItem("_bb_privkey", privkey);
      store.setItem("_bb_pubkey", pubkey);
      return keypair.signIn(privkey);
    },

    // Export the current keypair for backup — returns { privkey, pubkey }
    export: () => ({
      privkey: store.getItem("_bb_privkey"),
      pubkey: store.getItem("_bb_pubkey"),
    }),

    // Remove local keys (logout without losing the account — can restore later)
    forget: () => { store.removeItem("_bb_privkey"); store.removeItem("_bb_pubkey"); },
  };

  // --- Query builder ---
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
      const data = res.data ?? res;
      if (_single) {
        if (!Array.isArray(data) || !data.length) return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: 406 } };
        return { data: data[0], error: null };
      }
      if (_maybeSingle) return { data: Array.isArray(data) ? (data[0] ?? null) : data, error: null };
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
      not:         (col: string, op: string, val: any) => (q.filters.push(`not.${col}.${op}=${val}`), b),
      or:          (clause: string) => (q.filters.push(`or=${clause}`), b),
      filter:      (col: string, op: string, val: any) => (q.filters.push(`${op}.${col}=${val}`), b),
      order:       (col: string, { ascending = true } = {}) => (q.order = `${col}.${ascending ? "asc" : "desc"}`, b),
      limit:       (n: number) => (q.limit = n, b),
      offset:      (n: number) => (q.offset = n, b),
      range:       (from: number, to: number) => (q.offset = from, q.limit = to - from + 1, b),
      count:       (type: "exact" | "planned" | "estimated" = "exact") => (q.count = type, b),
      single:      () => (_single = true, b),
      maybeSingle: () => (_maybeSingle = true, b),
      vec:         (embedding: number[], limit = 10) => (q.vec = JSON.stringify(embedding), q.limit = limit, b),
      then:        (res: any, rej: any) => resolve().then(res, rej),
    };
    return b;
  };

  const wrap = (p: Promise<any>) => p.then((r: any) => r?.error !== undefined ? r : { data: r, error: null });

  const from = (table: string) => ({
    select:  (cols = "*") => Q(table).select(cols),
    insert:  (data: any) => wrap(req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]) })),
    upsert:  (data: any) => wrap(req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]) })),
    update:  (data: any) => Q(table, "PATCH", data),
    delete:  () => Q(table, "DELETE", null),
  });

  const auth = {
    // Anonymous-first: auto sign-in with keypair (default flow)
    signIn: () => keypair.signIn(),

    // Email/password
    signUp: ({ email, password, options }: { email: string; password: string; options?: any }) =>
      req("auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password, data: options?.data }) })
        .then((r: any) => { if (r.data?.session) { setSession_(r.data.session); emit("SIGNED_IN", session); } return r; }),

    signInWithPassword: ({ email, password }: { email: string; password: string }) =>
      req("auth/v1/token", { method: "POST", body: JSON.stringify({ email, password }) })
        .then((r: any) => { if (r.data?.session) { setSession_(r.data.session); emit("SIGNED_IN", session); } return r; }),

    signOut: () =>
      req("auth/v1/logout", { method: "POST" })
        .then((r: any) => { setSession_(null); emit("SIGNED_OUT", null); return r; }),

    getUser: () => req("auth/v1/user"),
    getSession: () => Promise.resolve({ data: { session }, error: null }),

    updateUser: (attrs: { email?: string; password?: string; data?: any }) =>
      req("auth/v1/update", { method: "PATCH", body: JSON.stringify(attrs) })
        .then((r: any) => { if (r.data?.user) emit("USER_UPDATED", session); return r; }),

    setSession: (s: { access_token: string; refresh_token: string }) => {
      setSession_(s);
      return Promise.resolve({ data: { session: s }, error: null });
    },

    resetPasswordForEmail: (_email: string) => Promise.resolve({ data: {}, error: null }),

    onAuthStateChange: (cb: (event: string, session: any) => void) => {
      authListeners.push(cb);
      cb("INITIAL_SESSION", session);
      return { data: { subscription: { unsubscribe: () => { const i = authListeners.indexOf(cb); if (i > -1) authListeners.splice(i, 1); } } } };
    },

    // Keypair namespace for advanced use
    keypair,
  };

  const channels = new Map<string, any>();

  const channel = (name: string) => {
    const handlers: Array<{ event: string; table: string; cb: (payload: any) => void }> = [];
    let ws: any = null;
    const wsUrl = base.replace(/^http/, "ws") + "/realtime/v1/websocket";

    const ch: any = {
      on: (type: string, opts: { event: string; schema?: string; table: string }, cb: (payload: any) => void) => {
        handlers.push({ event: opts.event, table: opts.table, cb });
        return ch;
      },
      subscribe: (statusCb?: (status: string) => void) => {
        ws = new (globalThis as any).WebSocket(wsUrl);
        ws.onopen = () => {
          const tables = [...new Set(handlers.map(h => h.table))];
          for (const t of tables) ws.send(JSON.stringify({ type: "subscribe", table: t }));
          statusCb?.("SUBSCRIBED");
        };
        ws.onmessage = (e: any) => {
          try {
            const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
            for (const h of handlers) {
              if (h.table === msg.table && (h.event === "*" || h.event === msg.eventType)) h.cb(msg);
            }
          } catch {}
        };
        ws.onerror = () => statusCb?.("CHANNEL_ERROR");
        ws.onclose = () => statusCb?.("CLOSED");
        channels.set(name, ch);
        return ch;
      },
      unsubscribe: () => { ws?.close(); channels.delete(name); },
    };
    return ch;
  };

  const removeAllChannels = () => { for (const ch of channels.values()) ch.unsubscribe(); };

  return { from, auth, channel, removeAllChannels };
};

export { BB as createClient };
export default BB;
