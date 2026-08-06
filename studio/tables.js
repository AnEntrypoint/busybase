const BASE = '/rest/v1';

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fetchTables() {
  const r = await fetch('/studio/api/tables');
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data || []).filter(t => !t.startsWith('_'));
}

async function fetchRows(table) {
  const r = await fetch(`${BASE}/${table}`);
  if (!r.ok) return [];
  const j = await r.json();
  return j.data || [];
}

async function deleteRow(table, id) {
  const r = await fetch(`${BASE}/${table}?eq.id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  const j = await r.json().catch(() => ({}));
  return j.error ? j.error.message : null;
}

async function addRow(table, row) {
  const r = await fetch(`${BASE}/${table}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row)
  });
  const j = await r.json().catch(() => ({}));
  return j.error ? j.error.message : null;
}

async function updateRow(table, id, key, value) {
  const r = await fetch(`${BASE}/${table}?eq.id=${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value })
  });
  const j = await r.json().catch(() => ({}));
  return j.error ? j.error.message : null;
}

export async function render(container) {
  let tables = [], selected = null, rows = [], editCell = null, newRow = {}, message = '';

  const draw = () => {
    const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
    container.innerHTML = `
      <div style="display:flex;gap:12px;height:100%">
        <div style="width:180px;border-right:1px solid #e5e7eb;padding-right:12px">
          <div style="font-weight:600;margin-bottom:8px">Tables</div>
          ${tables.map(t => `<div data-table="${esc(t)}" style="cursor:pointer;padding:4px 8px;border-radius:6px;background:${t===selected?'#6366f1':'transparent'};color:${t===selected?'#fff':'inherit'}">${esc(t)}</div>`).join('')}
        </div>
        <div style="flex:1;overflow:auto">
          ${!selected ? '<div style="color:#6b7280">Select a table</div>' : `
            <div style="font-weight:600;margin-bottom:8px">${esc(selected)} <span style="font-size:12px;color:#6b7280">(${rows.length} rows)</span></div>
            ${message ? `<div style="padding:6px 10px;background:#fee2e2;color:#991b1b;border-radius:6px;margin-bottom:8px;font-size:13px">${esc(message)}</div>` : ''}
            ${rows.length === 0 ? '<div style="color:#6b7280">No rows</div>' : `
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead><tr style="background:#f9fafb">${cols.map(c=>`<th style="text-align:left;padding:6px 8px;border:1px solid #e5e7eb">${esc(c)}</th>`).join('')}<th style="border:1px solid #e5e7eb">Actions</th></tr></thead>
                <tbody>${rows.map(row => `<tr>${cols.map(c => {
                  const isEdit = editCell && editCell.id === row.id && editCell.col === c;
                  return `<td style="padding:4px 8px;border:1px solid #e5e7eb" data-row="${esc(row.id)}" data-col="${esc(c)}">
                    ${isEdit ? `<input value="${esc(row[c])}" data-save="${esc(row.id)}" data-key="${esc(c)}" style="width:100%;border:1px solid #6366f1;border-radius:3px;padding:2px 4px" />` : `<span data-edit="${esc(row.id)}" data-editcol="${esc(c)}" style="cursor:pointer">${esc(row[c])}</span>`}
                  </td>`;
                }).join('')}<td style="padding:4px 8px;border:1px solid #e5e7eb"><button data-del="${esc(row.id)}" style="color:#ef4444;background:none;border:none;cursor:pointer">Delete</button></td></tr>`).join('')}</tbody>
              </table>
            `}
            <div style="margin-top:16px;padding:12px;background:#f9fafb;border-radius:8px">
              <div style="font-weight:600;margin-bottom:8px">Add Row</div>
              ${cols.filter(c=>c!=='id'&&c!=='vector').map(c=>`<input placeholder="${esc(c)}" data-newkey="${esc(c)}" value="${esc(newRow[c]||'')}" style="margin:4px;padding:6px 8px;border:1px solid #e5e7eb;border-radius:6px" />`).join('')}
              <button data-addrow="1" style="margin:4px;padding:6px 12px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer">Add</button>
            </div>
          `}
        </div>
      </div>`;

    container.querySelectorAll('[data-table]').forEach(el => el.addEventListener('click', async () => {
      selected = el.dataset.table; rows = await fetchRows(selected); editCell = null; newRow = {}; message = ''; draw();
    }));
    container.querySelectorAll('[data-del]').forEach(el => el.addEventListener('click', async () => {
      message = await deleteRow(selected, el.dataset.del) || '';
      rows = await fetchRows(selected); draw();
    }));
    container.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('click', () => {
      editCell = { id: el.dataset.edit, col: el.dataset.editcol }; draw();
    }));
    container.querySelectorAll('[data-save]').forEach(inp => {
      const save = async () => {
        message = await updateRow(selected, inp.dataset.save, inp.dataset.key, inp.value) || '';
        rows = await fetchRows(selected); editCell = null; draw();
      };
      inp.addEventListener('blur', save);
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    });
    container.querySelectorAll('[data-newkey]').forEach(inp => inp.addEventListener('input', () => { newRow[inp.dataset.newkey] = inp.value; }));
    container.querySelector('[data-addrow]')?.addEventListener('click', async () => {
      if (!selected) return;
      message = await addRow(selected, { id: crypto.randomUUID(), ...newRow }) || '';
      rows = await fetchRows(selected); if (!message) newRow = {}; draw();
    });
  };

  tables = await fetchTables();
  draw();
}
