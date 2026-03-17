export function render(container) {
  let ws = null, events = [], connected = false;

  const draw = () => {
    container.innerHTML = `
      <div style="height:100%;display:flex;flex-direction:column">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
          <div style="font-size:20px;font-weight:700">Realtime Events</div>
          <span style="padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;background:${connected?'#d1fae5':'#fee2e2'};color:${connected?'#065f46':'#991b1b'}">
            ${connected ? 'Connected' : 'Disconnected'}
          </span>
          <button id="rt-clear" style="margin-left:auto;padding:4px 12px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;cursor:pointer;font-size:13px">Clear</button>
          <button id="rt-toggle" style="padding:4px 12px;background:${connected?'#fee2e2':'#d1fae5'};border:1px solid ${connected?'#fca5a5':'#6ee7b7'};border-radius:6px;cursor:pointer;font-size:13px">
            ${connected ? 'Disconnect' : 'Connect'}
          </button>
        </div>
        <div style="flex:1;overflow:auto;background:#0f172a;border-radius:8px;padding:12px;font-family:monospace;font-size:12px">
          ${events.length === 0 ? '<div style="color:#475569">Waiting for events...</div>' :
            events.map(e => `<div style="margin-bottom:6px;color:#e2e8f0">
              <span style="color:#64748b">${e.ts}</span>
              <span style="color:${e.type==='INSERT'?'#34d399':e.type==='UPDATE'?'#fbbf24':e.type==='DELETE'?'#f87171':'#a78bfa'};margin:0 6px">${e.type}</span>
              <span style="color:#7dd3fc">${e.table||'*'}</span>
              <span style="color:#94a3b8;margin-left:6px">${JSON.stringify(e.payload)}</span>
            </div>`).join('')}
        </div>
      </div>`;

    container.querySelector('#rt-clear').addEventListener('click', () => { events = []; draw(); });
    container.querySelector('#rt-toggle').addEventListener('click', () => {
      if (connected) disconnect(); else connect();
    });
  };

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/realtime/v1/websocket`);
    ws.onopen = () => {
      connected = true;
      ws.send(JSON.stringify({ type: 'phx_join', topic: 'realtime:*', event: 'phx_join', payload: {}, ref: '1' }));
      draw();
    };
    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.payload && msg.event !== 'phx_reply' && msg.event !== 'heartbeat') {
          const pl = msg.payload;
          events.unshift({
            ts: new Date().toLocaleTimeString(),
            type: pl.type || msg.event,
            table: pl.table || (msg.topic||'').replace('realtime:',''),
            payload: pl.record || pl.old_record || pl
          });
          if (events.length > 200) events = events.slice(0, 200);
          draw();
        }
      } catch {}
    };
    ws.onclose = () => { connected = false; ws = null; draw(); };
    ws.onerror = () => { connected = false; draw(); };
  };

  const disconnect = () => { if (ws) { ws.close(); ws = null; } connected = false; draw(); };

  draw();
  connect();
}
