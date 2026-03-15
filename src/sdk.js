// src/sdk.ts
var b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
var unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
var genKeypair = async () => {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const [pub, priv] = await Promise.all([
    crypto.subtle.exportKey("raw", kp.publicKey),
    crypto.subtle.exportKey("pkcs8", kp.privateKey)
  ]);
  return { pubkey: b64(pub), privkey: b64(priv) };
};
var sign = async (privkeyB64, message) => {
  const key = await crypto.subtle.importKey("pkcs8", unb64(privkeyB64), { name: "Ed25519" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(message)));
};
var makeStore = () => {
  try {
    localStorage.setItem("_bb_", "1");
    localStorage.removeItem("_bb_");
    return localStorage;
  } catch {
    const m = new Map;
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  }
};
var BB = (url, key) => {
  let token = null;
  let session = null;
  const authListeners = [];
  const base = url.replace(/\/$/, "");
  const store = makeStore();
  const emit = (event, s) => authListeners.forEach((cb) => cb(event, s));
  const setSession_ = (s) => {
    session = s;
    token = s?.access_token ?? null;
  };
  const req = async (path, opts = {}) => {
    const r = await globalThis.fetch(`${base}/${path}`, {
      ...opts,
      headers: { apikey: key, Authorization: `Bearer ${token || key}`, "Content-Type": "application/json", ...opts.headers }
    });
    return r.json();
  };
  const keypair = {
    generate: genKeypair,
    signIn: async (privkeyB64) => {
      let privkey = privkeyB64 ?? store.getItem("_bb_privkey");
      let pubkey = store.getItem("_bb_pubkey");
      if (!privkey) {
        const kp = await genKeypair();
        privkey = kp.privkey;
        pubkey = kp.pubkey;
        store.setItem("_bb_privkey", privkey);
        store.setItem("_bb_pubkey", pubkey);
      } else if (!pubkey) {
        const privCrypto = await crypto.subtle.importKey("pkcs8", unb64(privkey), { name: "Ed25519" }, true, ["sign"]);
        return { data: null, error: { message: "Pubkey missing — call keypair.restore(privkey, pubkey)" } };
      }
      const nonceRes = await req("auth/v1/keypair");
      if (nonceRes.error)
        return nonceRes;
      const nonce = nonceRes.data.nonce;
      const signature = await sign(privkey, nonce);
      const r = await req("auth/v1/keypair", { method: "POST", body: JSON.stringify({ pubkey, nonce, signature }) });
      if (r.data?.session) {
        setSession_(r.data.session);
        store.setItem("_bb_privkey", privkey);
        store.setItem("_bb_pubkey", pubkey);
        emit("SIGNED_IN", session);
      }
      return r;
    },
    restore: async (privkey, pubkey) => {
      store.setItem("_bb_privkey", privkey);
      store.setItem("_bb_pubkey", pubkey);
      return keypair.signIn(privkey);
    },
    export: () => ({
      privkey: store.getItem("_bb_privkey"),
      pubkey: store.getItem("_bb_pubkey")
    }),
    forget: () => {
      store.removeItem("_bb_privkey");
      store.removeItem("_bb_pubkey");
    }
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
      const data = res.data ?? res;
      if (_single) {
        if (!Array.isArray(data) || !data.length)
          return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: 406 } };
        return { data: data[0], error: null };
      }
      if (_maybeSingle)
        return { data: Array.isArray(data) ? data[0] ?? null : data, error: null };
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
      not: (col, op, val) => (q.filters.push(`not.${col}.${op}=${val}`), b),
      or: (clause) => (q.filters.push(`or=${clause}`), b),
      filter: (col, op, val) => (q.filters.push(`${op}.${col}=${val}`), b),
      order: (col, { ascending = true } = {}) => (q.order = `${col}.${ascending ? "asc" : "desc"}`, b),
      limit: (n) => (q.limit = n, b),
      offset: (n) => (q.offset = n, b),
      range: (from2, to) => (q.offset = from2, q.limit = to - from2 + 1, b),
      count: (type = "exact") => (q.count = type, b),
      single: () => (_single = true, b),
      maybeSingle: () => (_maybeSingle = true, b),
      vec: (embedding, limit = 10) => (q.vec = JSON.stringify(embedding), q.limit = limit, b),
      then: (res, rej) => resolve().then(res, rej)
    };
    return b;
  };
  const wrap = (p) => p.then((r) => r?.error !== undefined ? r : { data: r, error: null });
  const from = (table) => ({
    select: (cols = "*") => Q(table).select(cols),
    insert: (data) => wrap(req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]) })),
    upsert: (data) => {
      const rows = Array.isArray(data) ? data : [data];
      const withIds = rows.map(r => ({ ...r, id: r.id ?? crypto.randomUUID() }));
      const doRow = async (r) => {
        const existing = await req(`rest/v1/${table}?eq.id=${encodeURIComponent(r.id)}`);
        if (existing?.data?.length) {
          return req(`rest/v1/${table}?eq.id=${encodeURIComponent(r.id)}`, { method: "PATCH", body: JSON.stringify(r) });
        }
        return req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify([r]) });
      };
      return wrap(Promise.all(withIds.map(doRow)).then(results => ({ data: results.flatMap(r => r?.data ?? []), error: null })));
    },
    update: (data) => Q(table, "PATCH", data),
    delete: () => Q(table, "DELETE", null)
  });
  const auth = {
    signIn: () => keypair.signIn(),
    signUp: ({ email, password, options }) => req("auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password, data: options?.data }) }).then((r) => {
      if (r.data?.session) {
        setSession_(r.data.session);
        emit("SIGNED_IN", session);
      }
      return r;
    }),
    signInWithPassword: ({ email, password }) => req("auth/v1/token", { method: "POST", body: JSON.stringify({ email, password }) }).then((r) => {
      if (r.data?.session) {
        setSession_(r.data.session);
        emit("SIGNED_IN", session);
      }
      return r;
    }),
    signOut: () => req("auth/v1/logout", { method: "POST" }).then((r) => {
      setSession_(null);
      emit("SIGNED_OUT", null);
      return r;
    }),
    getUser: () => req("auth/v1/user"),
    getSession: () => Promise.resolve({ data: { session }, error: null }),
    updateUser: (attrs) => req("auth/v1/update", { method: "PATCH", body: JSON.stringify(attrs) }).then((r) => {
      if (r.data?.user)
        emit("USER_UPDATED", session);
      return r;
    }),
    setSession: (s) => {
      setSession_(s);
      return Promise.resolve({ data: { session: s }, error: null });
    },
    resetPasswordForEmail: (_email) => Promise.resolve({ data: {}, error: null }),
    onAuthStateChange: (cb) => {
      authListeners.push(cb);
      cb("INITIAL_SESSION", session);
      return { data: { subscription: { unsubscribe: () => {
        const i = authListeners.indexOf(cb);
        if (i > -1)
          authListeners.splice(i, 1);
      } } } };
    },
    keypair
  };
  const channels = new Map();
  const channel = (name) => {
    const handlers = [];
    let ws = null;
    const wsUrl = base.replace(/^http/, "ws") + "/realtime/v1/websocket";
    const ch = {
      on: (type, opts, cb) => { handlers.push({ event: opts.event, table: opts.table, cb }); return ch; },
      subscribe: (statusCb) => {
        ws = new (globalThis.WebSocket)(wsUrl);
        ws.onopen = () => {
          const tables = [...new Set(handlers.map(h => h.table))];
          for (const t of tables) ws.send(JSON.stringify({ type: "subscribe", table: t }));
          statusCb?.("SUBSCRIBED");
        };
        ws.onmessage = (e) => {
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
var sdk_default = BB;
export {
  sdk_default as default,
  BB as createClient
};
