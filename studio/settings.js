export async function render(container) {
  let config = null, error = null;

  const r = await fetch('/studio/config');
  if (r.ok) { const j = await r.json(); config = j.data || j; }
  else { error = 'Failed to load config'; }

  const origin = config ? config.BUSYBASE_URL || `${location.protocol}//${location.hostname}:${config.BUSYBASE_PORT || 54321}` : location.origin;

  container.innerHTML = `
    <div>
      <div style="font-size:20px;font-weight:700;margin-bottom:16px">Settings</div>
      ${error ? `<div style="color:#ef4444;margin-bottom:12px">${error}</div>` : ''}
      ${config ? `
        <div style="margin-bottom:24px">
          <div style="font-weight:600;margin-bottom:8px">Server Configuration</div>
          <table style="border-collapse:collapse;font-size:13px;min-width:400px">
            <thead><tr style="background:#f9fafb">
              <th style="text-align:left;padding:8px 12px;border:1px solid #e5e7eb">Key</th>
              <th style="text-align:left;padding:8px 12px;border:1px solid #e5e7eb">Value</th>
            </tr></thead>
            <tbody>
              ${Object.entries(config).map(([k,v]) => `<tr>
                <td style="padding:8px 12px;border:1px solid #e5e7eb;font-family:monospace;font-weight:600">${k}</td>
                <td style="padding:8px 12px;border:1px solid #e5e7eb;font-family:monospace">${v}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}

      <div style="margin-bottom:24px">
        <div style="font-weight:600;margin-bottom:8px">SDK Quick Start</div>
        <pre style="background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;font-size:12px;overflow:auto"><code>import { createClient } from 'busybase';

const db = createClient('${origin}', 'your-anon-key');

// Email auth
const { data: { user } } = await db.auth.signUp({ email: 'user@example.com', password: 'password' });
const { data: { session } } = await db.auth.signInWithPassword({ email: 'user@example.com', password: 'password' });

// CRUD
const { data } = await db.from('todos').select('*');
await db.from('todos').insert({ id: crypto.randomUUID(), title: 'Hello' });
await db.from('todos').update({ title: 'Updated' }).eq('id', '...');
await db.from('todos').delete().eq('id', '...');

// Realtime
db.channel('changes')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'todos' }, row => console.log('New:', row))
  .subscribe();</code></pre>
      </div>

      <div>
        <div style="font-weight:600;margin-bottom:8px">Embedded Mode</div>
        <pre style="background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;font-size:12px;overflow:auto"><code>import { createEmbedded } from 'busybase/embedded';

const db = await createEmbedded({ dir: './data' });
const { data } = await db.from('items').select('*');</code></pre>
      </div>
    </div>`;
}
