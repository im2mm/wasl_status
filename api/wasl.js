/**
 * WASL Status backend (Vercel Node function): POST /api/wasl
 *
 * Body (JSON): { "username": "...", "password": "...", "host": "https://ksa.pilot-gps.com" }
 *
 * Signs in to PILOT server-side, so the PILOT session in the user's browser is not switched,
 * reads the vehicle list and the WASL values from PILOT's live WebSocket, signs out and returns
 *   { account, vehicles: [{ id, name, plate, group, imei }], wasl: { <id>: { wasl, wasl_state } } }
 *
 * Nothing is stored or logged; the credentials live only for the duration of the request.
 * Needs Node 22+ (global WebSocket with the `headers` option).
 */

const HOST_RE = /^https:\/\/([a-z0-9-]+\.)*pilot-gps\.com$/i;
const DEFAULT_HOST = 'https://ksa.pilot-gps.com';
const UA = 'wasl-status-extension/1.0';

function cors(req, res) {
    const origin = req.headers.origin || '';
    if (HOST_RE.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Cache-Control', 'no-store');
}

function send(res, status, body) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

async function readBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const txt = Buffer.concat(chunks).toString('utf8');
    return txt ? JSON.parse(txt) : {};
}

function cookieFrom(resp) {
    const list = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : [resp.headers.get('set-cookie') || ''];
    for (const c of list) {
        const m = /(?:^|,\s*)(PILOTID=[^;]+)/.exec(c || '');
        if (m) return m[1];
    }
    return null;
}

/** POST <backend>/ with username/password (same as PILOT's login form). Follows a node redirect once. */
async function login(backend, username, password, hop = 0) {
    const resp = await fetch(backend, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
        body: new URLSearchParams({ username, password, remember: 'false' }).toString(),
        redirect: 'manual'
    });
    let json = null;
    try { json = await resp.json(); } catch { /* not JSON */ }
    if (!json) throw Object.assign(new Error('Unexpected answer from PILOT sign-in (HTTP ' + resp.status + ').'), { status: 502 });
    if (json.need_email_2fa || json.need_2fa || json.totp) {
        throw Object.assign(new Error('This account uses two-factor sign-in, which the extension cannot do.'), { status: 401 });
    }
    if (!json.success) throw Object.assign(new Error(json.msg || 'Invalid Login or Password'), { status: 401 });
    const nodeUrl = json.node && json.node.url;
    if (nodeUrl && hop === 0) {
        const u = new URL(nodeUrl);
        if (!HOST_RE.test(u.origin)) throw Object.assign(new Error('PILOT sent the sign-in to an unknown server.'), { status: 502 });
        return login(nodeUrl.endsWith('/') ? nodeUrl : nodeUrl + '/', username, password, 1);
    }
    const cookie = cookieFrom(resp);
    if (!cookie) throw Object.assign(new Error('PILOT did not open a session.'), { status: 502 });
    return { backend, cookie };
}

function vehiclesFromTree(nodes) {
    const out = [];
    const seen = new Set();
    (function walk(list, folder) {
        for (const n of list || []) {
            if (!n) continue;
            if (n.children && n.children.length) { walk(n.children, n.name || n.text || folder); continue; }
            const id = Number(n.agentid || n.vehid || 0);
            if (id > 0 && !seen.has(id)) {
                seen.add(id);
                out.push({ id, name: String(n.name || n.text || id), plate: n.info || '', group: folder || n.group || '', imei: n.uniqid || '' });
            }
        }
    })(Array.isArray(nodes) ? nodes : (nodes && nodes.children) || [], '');
    return out;
}

function collectWasl(backend, cookie, ids) {
    return new Promise((resolve, reject) => {
        const data = {};
        let seen = 0, done = false, quiet = null;
        // PILOT answers with this subprotocol for a signed-in session (and refuses otherwise).
        const ws = new WebSocket(backend.replace(/^http/i, 'ws') + 'WS', {
            protocols: ['zap-protocol-v1'],
            headers: { Cookie: cookie, Origin: new URL(backend).origin, 'User-Agent': UA }
        });
        const finish = (err) => {
            if (done) return;
            done = true;
            clearTimeout(quiet); clearTimeout(cap);
            try { ws.close(); } catch { /* ignore */ }
            if (err && !seen) reject(err); else resolve(data);
        };
        const cap = setTimeout(() => finish(seen ? null : new Error('PILOT live connection did not answer.')), 25000);
        ws.onopen = () => ws.send(ids.join(','));
        ws.onerror = () => finish(new Error('Could not open the PILOT live connection.'));
        ws.onclose = () => finish(seen ? null : new Error('PILOT live connection closed.'));
        ws.onmessage = (ev) => {
            let arr;
            try { arr = JSON.parse(String(ev.data)); } catch {
                if (/access denied/i.test(String(ev.data))) finish(new Error('PILOT refused the live connection for this account.'));
                return;
            }
            if (!Array.isArray(arr)) arr = [arr];
            for (const o of arr) {
                const id = o && Number(o.veh_id || o.id);
                if (!id) continue;
                if (!data[id]) { data[id] = {}; seen++; }
                if (Number(o.wasl) > 0) data[id].wasl = Number(o.wasl);
                if (o.wasl_state) data[id].wasl_state = String(o.wasl_state);
            }
            if (seen >= ids.length) return finish();
            clearTimeout(quiet);
            quiet = setTimeout(() => finish(), 3000);
        };
    });
}

module.exports = async function handler(req, res) {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });

    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'Invalid JSON body.' }); }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    let host = String(body.host || DEFAULT_HOST).replace(/\/+$/, '');
    if (!HOST_RE.test(host)) host = DEFAULT_HOST;
    if (!username || !password) return send(res, 400, { error: 'Enter the login and the password.' });

    let session = null;
    try {
        session = await login(host + '/backend/', username, password);
        const treeResp = await fetch(session.backend + 'ax/tree.php?vehs=1&state=2&node=root', {
            headers: { Cookie: session.cookie, 'user-agent': UA }
        });
        if (!treeResp.ok) throw Object.assign(new Error('PILOT vehicle list failed (HTTP ' + treeResp.status + ').'), { status: 502 });
        const vehicles = vehiclesFromTree(await treeResp.json());
        const wasl = vehicles.length ? await collectWasl(session.backend, session.cookie, vehicles.map(v => v.id)) : {};
        return send(res, 200, { account: username, vehicles, wasl });
    } catch (e) {
        return send(res, e.status || 502, { error: e.message || String(e) });
    } finally {
        if (session) {
            fetch(session.backend + 'ax/user/logout.php', { headers: { Cookie: session.cookie, 'user-agent': UA } }).catch(() => {});
        }
    }
};
