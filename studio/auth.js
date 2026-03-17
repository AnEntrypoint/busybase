export async function render(container) {
  let users = [], email = '', password = '', message = '';

  const loadUsers = async () => {
    const r = await fetch('/rest/v1/_users');
    if (!r.ok) { users = []; return; }
    const j = await r.json();
    users = (j.data || []).filter(u => u.id !== '_sentinel_');
  };

  const draw = () => {
    container.innerHTML = `
      <div>
        <div style="font-size:20px;font-weight:700;margin-bottom:16px">Users</div>
        ${message ? `<div style="padding:8px 12px;background:${message.startsWith('Error')?'#fee2e2':'#d1fae5'};border-radius:6px;margin-bottom:12px;font-size:13px">${message}</div>` : ''}
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px">
          <thead><tr style="background:#f9fafb">
            <th style="text-align:left;padding:8px;border:1px solid #e5e7eb">ID</th>
            <th style="text-align:left;padding:8px;border:1px solid #e5e7eb">Email</th>
            <th style="text-align:left;padding:8px;border:1px solid #e5e7eb">Role</th>
            <th style="text-align:left;padding:8px;border:1px solid #e5e7eb">Created</th>
          </tr></thead>
          <tbody>
            ${users.length === 0 ? '<tr><td colspan="4" style="padding:12px 8px;color:#6b7280;border:1px solid #e5e7eb">No users found</td></tr>' :
              users.map(u => `<tr>
                <td style="padding:8px;border:1px solid #e5e7eb;font-family:monospace;font-size:11px">${u.id||''}</td>
                <td style="padding:8px;border:1px solid #e5e7eb">${u.email||''}</td>
                <td style="padding:8px;border:1px solid #e5e7eb">${u.role||'authenticated'}</td>
                <td style="padding:8px;border:1px solid #e5e7eb">${u.created||''}</td>
              </tr>`).join('')}
          </tbody>
        </table>

        <div style="padding:16px;background:#f9fafb;border-radius:8px;max-width:400px">
          <div style="font-weight:600;margin-bottom:12px">Create User</div>
          <div style="margin-bottom:8px">
            <label style="display:block;font-size:13px;margin-bottom:4px">Email</label>
            <input id="auth-email" type="email" value="${email}" placeholder="user@example.com"
              style="width:100%;padding:8px;border:1px solid #e5e7eb;border-radius:6px;font-size:14px;box-sizing:border-box" />
          </div>
          <div style="margin-bottom:12px">
            <label style="display:block;font-size:13px;margin-bottom:4px">Password</label>
            <input id="auth-password" type="password" value="${password}" placeholder="••••••••"
              style="width:100%;padding:8px;border:1px solid #e5e7eb;border-radius:6px;font-size:14px;box-sizing:border-box" />
          </div>
          <button id="auth-submit"
            style="padding:8px 16px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px">
            Create User
          </button>
        </div>
      </div>`;

    container.querySelector('#auth-email').addEventListener('input', e => { email = e.target.value; });
    container.querySelector('#auth-password').addEventListener('input', e => { password = e.target.value; });
    container.querySelector('#auth-submit').addEventListener('click', async () => {
      if (!email || !password) { message = 'Error: Email and password required'; draw(); return; }
      const r = await fetch('/auth/v1/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const j = await r.json();
      if (j.error) { message = `Error: ${j.error.message}`; draw(); return; }
      message = `Created user: ${email}`; email = ''; password = '';
      await loadUsers(); draw();
    });
  };

  await loadUsers();
  draw();
}
