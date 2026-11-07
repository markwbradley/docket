/* Docket: a Today list that mirrors Todoist's Today view.
   This Worker serves the page and a small API. It talks to Todoist with
   Mark's API token (secret TODOIST_TOKEN) and keeps temp tasks in KV.
   Every request must carry a valid Cloudflare Access sign-in; without the
   Access settings (secrets ACCESS_TEAM_DOMAIN and ACCESS_AUD) it refuses
   everything rather than run open. */

const TD = 'https://api.todoist.com/api/v1';
const TZ = 'Europe/London';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const who = await signedIn(request, env);
    if (!who.ok) return text(who.message, 403);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!env.TODOIST_TOKEN && url.pathname !== '/api/local') return json({ error: 'not_configured', message: 'The Todoist token has not been added to the Worker yet.' }, 500);
    try {
      return await route(url, request, env);
    } catch (e) {
      const status = e && e.status ? e.status : 502;
      return json({ error: e.code || 'todoist_error', message: String((e && e.message) || e) }, status);
    }
  }
};

async function route(url, request, env) {
  const p = url.pathname, m = request.method;
  if (p === '/api/today' && m === 'GET') return json({ tasks: await todayTasks(env) });
  if (p === '/api/projects' && m === 'GET') return json({ projects: await projects(env) });
  /* Next actions and email proposals, for the left-hand pane. */
  if (p === '/api/next' && m === 'GET') {
    const raw = await paged(env, '/tasks/filter?query=' + encodeURIComponent('@next | @proposed'));
    return json({ tasks: raw.filter(t => !t.checked && !t.completed_at && !t.is_deleted).map(norm) });
  }
  /* One project's open tasks, for choosing its next action. */
  if (p === '/api/project-tasks' && m === 'GET') {
    const id = url.searchParams.get('projectId') || '';
    if (!/^[\w-]+$/.test(id)) return json({ error: 'bad_project' }, 400);
    const raw = await paged(env, '/tasks?project_id=' + encodeURIComponent(id));
    return json({ tasks: raw.filter(t => !t.checked && !t.completed_at && !t.is_deleted).map(norm) });
  }
  /* A small, fixed set of edits: rename and relabel, move, add, and delete
     a proposal. Delete is refused unless the task still carries `proposed`. */
  if (p === '/api/ops' && m === 'POST') {
    const body = await request.json();
    const ops = Array.isArray(body.ops) ? body.ops.slice(0, 20) : [];
    const cmds = [];
    for (const o of ops) {
      const id = o.id == null ? '' : String(o.id);
      if (o.op !== 'add' && !/^[\w-]+$/.test(id)) return json({ error: 'bad_id' }, 400);
      if (o.op === 'update') {
        const args = { id };
        if (typeof o.content === 'string') {
          const c = o.content.trim();
          if (!c || c.length > 500) return json({ error: 'bad_content' }, 400);
          args.content = c;
        }
        if (Array.isArray(o.labels)) args.labels = o.labels.map(String).slice(0, 30);
        cmds.push({ type: 'item_update', uuid: crypto.randomUUID(), args, _id: id });
      } else if (o.op === 'move') {
        if (!/^[\w-]+$/.test(String(o.projectId || ''))) return json({ error: 'bad_project' }, 400);
        cmds.push({ type: 'item_move', uuid: crypto.randomUUID(), args: { id, project_id: String(o.projectId) }, _id: id });
      } else if (o.op === 'add') {
        const c = String(o.content || '').trim();
        if (!c || c.length > 500 || !/^[\w-]+$/.test(String(o.projectId || ''))) return json({ error: 'bad_add' }, 400);
        const tmp = crypto.randomUUID();
        cmds.push({ type: 'item_add', uuid: crypto.randomUUID(), temp_id: tmp, args: { content: c, project_id: String(o.projectId), labels: Array.isArray(o.labels) ? o.labels.map(String).slice(0, 30) : [] }, _id: tmp });
      } else if (o.op === 'delete') {
        const t = await td(env, '/tasks/' + encodeURIComponent(id));
        if (!(t.labels || []).includes('proposed')) return json({ error: 'not_a_proposal', message: 'Only a proposed task can be dismissed from Docket.' }, 400);
        cmds.push({ type: 'item_delete', uuid: crypto.randomUUID(), args: { id }, _id: id });
      } else {
        return json({ error: 'bad_op' }, 400);
      }
    }
    return json(await sync(env, cmds));
  }
  if (p === '/api/update' && m === 'POST') {
    const body = await request.json();
    const cmds = (body.changes || []).map(c => {
      const args = { id: String(c.id) };
      if (c.date) {
        args.due = { date: c.date, lang: 'en' };
        /* Keeping the repeat rule: send it back with the new date, the
           way Todoist's own apps move one occurrence of a repeating task. */
        if (c.recurring && c.string) { args.due.string = c.string; args.due.is_recurring = true; }
      }
      if (c.durationMin) args.duration = { amount: Math.round(c.durationMin), unit: 'minute' };
      return { type: 'item_update', uuid: crypto.randomUUID(), args, _id: args.id };
    });
    return json(await sync(env, cmds));
  }
  if (p === '/api/unschedule' && m === 'POST') {
    const body = await request.json();
    /* A next action that had no date goes back to having none. */
    const due = body.date ? { date: body.date, lang: 'en' } : null;
    return json(await sync(env, [{ type: 'item_update', uuid: crypto.randomUUID(), args: { id: String(body.id), due }, _id: String(body.id) }]));
  }
  if ((p === '/api/complete' || p === '/api/reopen') && m === 'POST') {
    const body = await request.json();
    const type = p === '/api/complete' ? 'item_close' : 'item_uncomplete';
    return json(await sync(env, (body.ids || []).map(id => ({ type, uuid: crypto.randomUUID(), args: { id: String(id) }, _id: String(id) }))));
  }
  if (p === '/api/local') {
    const date = url.searchParams.get('date') || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'bad_date' }, 400);
    const key = 'local:' + date;
    if (m === 'GET') return json((await env.DOCKET.get(key, 'json')) || { temps: [], done: [] });
    if (m === 'PUT') {
      const body = await request.json();
      /* orig: where each task Docket scheduled today was before, so "Not today" can put it back. */
      const orig = body.orig && typeof body.orig === 'object' ? body.orig : {};
      await env.DOCKET.put(key, JSON.stringify({ temps: body.temps || [], done: body.done || [], orig, updatedAt: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * 14 });
      return json({ ok: true });
    }
  }
  return json({ error: 'not_found' }, 404);
}

/* ---------- Todoist ---------- */
async function td(env, path, init) {
  const res = await fetch(TD + path, Object.assign({}, init, { headers: Object.assign({ Authorization: 'Bearer ' + env.TODOIST_TOKEN }, (init && init.headers) || {}) }));
  if (!res.ok) {
    const body = await res.text();
    const err = new Error('Todoist answered ' + res.status + (body ? ': ' + body.slice(0, 200) : ''));
    err.code = res.status === 401 || res.status === 403 ? 'todoist_auth' : 'todoist_error';
    err.status = res.status === 401 || res.status === 403 ? 502 : 502;
    throw err;
  }
  return res.json();
}
async function paged(env, path) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await td(env, path + sep + 'limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    (r.results || r.items || []).forEach(x => out.push(x));
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  return out;
}
async function todayTasks(env) {
  const raw = await paged(env, '/tasks/filter?query=' + encodeURIComponent('today | overdue'));
  return raw.filter(t => !t.checked && !t.completed_at && !t.is_deleted).map(norm);
}
async function projects(env) {
  const raw = await paged(env, '/projects');
  return raw.filter(p => !p.is_archived && !p.is_deleted).map(p => ({
    id: p.id, name: p.name, parentId: p.parent_id || null, order: p.child_order || 0,
    inboxProject: !!(p.inbox_project || p.is_inbox_project), outcome: outcomeOf(p.description || '')
  }));
}
/* The project's outcome in a line: the "What this is for" block if the old
   four-block format is still there, otherwise the first line. */
function outcomeOf(desc) {
  let s = String(desc);
  const m = s.match(/\*\*What this is for\.?\*\*\s*([\s\S]*?)(?:\n\s*\*\*|$)/i);
  s = m ? m[1] : (s.split(/\n/).find(l => l.trim()) || '');
  s = s.replace(/\*\*|__|`|_/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > 160) { const cut = s.slice(0, 160); s = (cut.lastIndexOf('. ') > 60 ? cut.slice(0, cut.lastIndexOf('. ') + 1) : cut.replace(/\s+\S*$/, '') + '…'); }
  return s;
}
async function sync(env, cmds) {
  if (!cmds.length) return { ok: true, failures: [] };
  const commands = cmds.map(c => c.temp_id ? { type: c.type, uuid: c.uuid, temp_id: c.temp_id, args: c.args } : { type: c.type, uuid: c.uuid, args: c.args });
  const r = await td(env, '/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'commands=' + encodeURIComponent(JSON.stringify(commands))
  });
  const st = r.sync_status || {};
  const failures = cmds.filter(c => st[c.uuid] !== 'ok').map(c => ({ id: c._id, error: st[c.uuid] && st[c.uuid].error ? st[c.uuid].error : 'not confirmed' }));
  return { ok: !failures.length, failures, ids: r.temp_id_mapping || {} };
}

/* The page works in London wall-clock time: "2026-11-06T12:15:00". */
function localStamp(d) {
  const parts = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach(x => { parts[x.type] = x.value; });
  return parts.year + '-' + parts.month + '-' + parts.day + 'T' + parts.hour + ':' + parts.minute + ':' + parts.second;
}
function normDue(due) {
  if (!due) return null;
  const raw = due.datetime || due.date;
  if (!raw) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) return localStamp(new Date(raw));
  return raw.length > 19 ? raw.slice(0, 19) : raw;
}
function norm(t) {
  const prio = { 4: 'p1', 3: 'p2', 2: 'p3', 1: 'p4' }[t.priority] || 'p4';
  let duration = null;
  if (t.duration && t.duration.amount) duration = t.duration.unit === 'day' ? null : Math.round(t.duration.amount) + 'm';
  return {
    id: t.id, content: t.content, projectId: t.project_id, priority: prio, labels: t.labels || [],
    dueDate: normDue(t.due), recurring: !!(t.due && t.due.is_recurring), dueString: (t.due && t.due.string) || '',
    duration, order: t.child_order || 0, parentId: t.parent_id || null,
    /* Only proposals need their note: who it came from, and the link. */
    note: (t.labels || []).includes('proposed') ? String(t.description || '').slice(0, 400) : ''
  };
}

/* ---------- Cloudflare Access ---------- */
let certCache = { at: 0, keys: null, team: '' };
async function signedIn(request, env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const aud = String(env.ACCESS_AUD || '').trim();
  if (!team || !aud) return { ok: false, message: 'Docket is locked: Cloudflare Access is not set up yet (ACCESS_TEAM_DOMAIN and ACCESS_AUD).' };
  let token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) {
    const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
    token = m && m[1];
  }
  if (!token) return { ok: false, message: 'Not signed in.' };
  try {
    const [h, p, s] = token.split('.');
    const header = JSON.parse(b64text(h)), payload = JSON.parse(b64text(p));
    if (!certCache.keys || certCache.team !== team || Date.now() - certCache.at > 3600000) {
      const r = await fetch('https://' + team + '/cdn-cgi/access/certs');
      certCache = { at: Date.now(), keys: (await r.json()).keys || [], team };
    }
    const jwk = certCache.keys.find(k => k.kid === header.kid);
    if (!jwk) return { ok: false, message: 'Sign-in key not recognised. Reload the page.' };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64bytes(s), new TextEncoder().encode(h + '.' + p));
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!good || !auds.includes(aud) || !(payload.exp * 1000 > Date.now()) || payload.iss !== 'https://' + team) return { ok: false, message: 'Sign-in not valid. Reload the page to sign in again.' };
    const allowed = String(env.ALLOWED_EMAILS || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (allowed.length && !allowed.includes(String(payload.email || '').toLowerCase())) return { ok: false, message: 'This account is not allowed to use Docket.' };
    return { ok: true, email: payload.email };
  } catch (e) {
    return { ok: false, message: 'Sign-in could not be checked. Reload the page.' };
  }
}
function b64bytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64text(s) { return new TextDecoder().decode(b64bytes(s)); }

function json(obj, status) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
function text(msg, status) { return new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }); }
