export async function render(container) {
  let tables = [], selected = '', filter = '', rows = [], cols = [], error = null, loading = false;

  const loadTables = async () => {
    const r = await fetch('/studio/api/tables');
    if (!r.ok) return;
    const j = await r.json();
    tables = (j.data || []).filter(t => !t.startsWith('_'));
    if (tables.length > 0 && !selected) selected = tables[0];
  };

  const runQuery = async () => {
    if (!selected) return;
    loading = true; error = null; draw();
    const url = filter.trim() ? `/rest/v1/${selected}?${filter.trim()}` : `/rest/v1/${selected}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) { error = j.error.message; rows = []; cols = []; }
    else {
      rows = j.data || [];
      cols = rows.length > 0 ? Object.keys(rows[0]) : [];
    }
    loading = false; draw();
  };

  const draw = () => {
    container.innerHTML = `
      <div>
        <div style="font-size:20px;font-weight:700;margin-bottom:16px">Query</div>
        <div style="display:flex;gap:8px;margin-bottom:12px;align-items:flex-end">
          <div>
            <label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px">Table</label>
            <select id="sql-table" style="padding:8px;border:1px solid #e5e7eb;border-radius:6px;font-size:14px;min-width:160px">
              ${tables.map(t => `<option value="${t}" ${t===selected?'selected':''}>${t}</option>`).join('')}
            </select>
          </div>
          <div style="flex:1">
            <label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px">Filter (LanceDB syntax, e.g. eq.name=Alice)</label>
            <input id="sql-filter" value="${filter}" placeholder="eq.status=active"
              style="width:100%;padding:8px;border:1px solid #e5e7eb;border-radius:6px;font-size:14px;box-sizing:border-box" />
          </div>
          <button id="sql-run" style="padding:8px 20px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;white-space:nowrap">
            ${loading ? 'Running...' : 'Run'}
          </button>
        </div>
        ${error ? `<div style="padding:8px 12px;background:#fee2e2;color:#991b1b;border-radius:6px;margin-bottom:12px;font-size:13px">Error: ${error}</div>` : ''}
        ${rows.length === 0 && !error ? '<div style="color:#6b7280;font-size:13px">No results. Select a table and click Run.</div>' : ''}
        ${rows.length > 0 ? `
          <div style="overflow:auto">
            <div style="font-size:12px;color:#6b7280;margin-bottom:6px">${rows.length} row${rows.length===1?'':'s'}</div>
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="background:#f9fafb">
                ${cols.map(c => `<th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb;white-space:nowrap">${c}</th>`).join('')}
              </tr></thead>
              <tbody>
                ${rows.map(row => `<tr>${cols.map(c => `<td style="padding:6px 8px;border:1px solid #e5e7eb;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${row[c]??''}</td>`).join('')}</tr>`).join('')}
              </tbody>
            </table>
          </div>
        ` : ''}
      </div>`;

    container.querySelector('#sql-table')?.addEventListener('change', e => { selected = e.target.value; });
    container.querySelector('#sql-filter')?.addEventListener('input', e => { filter = e.target.value; });
    container.querySelector('#sql-filter')?.addEventListener('keydown', e => { if (e.key === 'Enter') runQuery(); });
    container.querySelector('#sql-run')?.addEventListener('click', runQuery);
  };

  await loadTables();
  draw();
}
