/**
 * PILOT Extension: wasl_status
 *
 * Lists every vehicle of a PILOT account with its WASL connection:
 *   - WASL           : last time WASL accepted data for the vehicle (PILOT's "WASL" column)
 *   - WASL State     : "Connected" when WASL returned a state for the vehicle, else "Not connected"
 *   - WASL Response  : the state WASL returned (PILOT's "WASL STATE" column),
 *                      e.g. MOVING, PARKED_ENGINE_ON, PARKED_ENGINE_OFF, DEVICE_NO_SIGNAL
 *
 * When the tab is opened it asks which account to read:
 *   - Current account : the account signed in to PILOT. Read in this browser, nothing else changes.
 *   - Another account : username + password of another PILOT account. The sign-in is done by the
 *                       extension's backend (api/wasl.js), so the PILOT session in this browser
 *                       is NOT switched. The password is kept only in memory for "Refresh".
 *
 * Data sources (runtime observations of PILOT 7.x, not part of the documented /api/v3 surface):
 *   - <base_url>ax/tree.php?vehs=1&state=2&node=root   hierarchical vehicle list
 *   - <base_url>WS (WebSocket)                          send "id1,id2,..." -> PILOT pushes the live
 *                                                       state of each vehicle, including `wasl`
 *                                                       (unix seconds) and `wasl_state` (text)
 *
 * Everything lives in this single file (no extra Ext.Loader classes).
 */
(function () {
    var EXT = 'wasl_status';
    var VERSION = '1.0.0';
    var API_DEFAULT = '/store/' + EXT + '/api/wasl';   // backend for "Another account"
    var FRESH_SECONDS = 3600;                          // PILOT colours a WASL time older than 1 h as off

    function t(s) {
        try { return (typeof window.l === 'function') ? window.l(s) : s; } catch (e) { return s; }
    }

    function storageGet(k, d) {
        try { var v = localStorage.getItem(EXT + '_' + k); return v === null ? d : v; } catch (e) { return d; }
    }

    function storageSet(k, v) {
        try { localStorage.setItem(EXT + '_' + k, v); } catch (e) { /* private mode */ }
    }

    function esc(s) {
        return Ext.String.htmlEncode(s === undefined || s === null ? '' : String(s));
    }

    function pilotBase() {
        // PILOT declares base_url as a global lexical binding (not always a window property).
        /* global base_url */
        var b = (typeof base_url === 'string' && base_url) ? base_url : '/backend/';
        if (!/^https?:/i.test(b)) { b = location.origin + (b.charAt(0) === '/' ? '' : '/') + b; }
        return b.charAt(b.length - 1) === '/' ? b : b + '/';
    }

    function wsUrl() {
        return pilotBase().replace(/^http/i, 'ws') + 'WS';
    }

    function fmtTime(ts) {
        if (!ts) { return ''; }
        try {
            if (typeof window.dateTimeStr === 'function') { return window.dateTimeStr(ts); }
        } catch (e) { /* fall through */ }
        return new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).format(new Date(ts * 1000));
    }

    function fmtAge(ts) {
        if (!ts) { return ''; }
        var s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
        if (s < 60) { return s + ' s ago'; }
        if (s < 3600) { return Math.floor(s / 60) + ' min ago'; }
        if (s < 86400) { return Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min ago'; }
        return Math.floor(s / 86400) + ' d ago';
    }

    var collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

    function naturalName(a, b) {
        return collator.compare(String(a.get('name') || ''), String(b.get('name') || ''));
    }

    /** Walks the hierarchical tree.php answer and returns the vehicles with their folder name. */
    function vehiclesFromTree(nodes) {
        var out = [], seen = {};
        (function walk(list, folder) {
            Ext.Array.forEach(list || [], function (n) {
                if (!n) { return; }
                if (n.children && n.children.length) {
                    walk(n.children, n.name || n.text || folder);
                    return;
                }
                var id = Number(n.agentid || n.vehid || 0);
                if (id > 0 && !seen[id]) {
                    seen[id] = true;
                    out.push({
                        id: id,
                        name: String(n.name || n.text || id).trim(),
                        plate: n.info || '',
                        group: folder || n.group || '',
                        imei: n.uniqid || ''
                    });
                }
            });
        })(Ext.isArray(nodes) ? nodes : (nodes && nodes.children) || [], '');
        return out;
    }

    /** Builds the grid rows from the vehicle list and the WASL values (by vehicle id). */
    function buildRows(vehicles, wasl) {
        return Ext.Array.map(vehicles, function (v) {
            var w = wasl[v.id] || {},
                ts = Number(w.wasl) > 0 ? Number(w.wasl) : null,
                st = w.wasl_state ? String(w.wasl_state) : '';
            return Ext.apply({ wasl: ts, response: st, connected: st ? 1 : 0 }, v);
        });
    }

    /**
     * Opens PILOT's live WebSocket in this browser session, sends the vehicle ids and collects
     * the first snapshot. Resolves with { id: { wasl, wasl_state } }.
     */
    function collectWasl(ids) {
        return new Promise(function (resolve, reject) {
            var data = {}, seen = 0, need = ids.length, quietTimer = null, done = false, ws;

            function finish(err) {
                if (done) { return; }
                done = true;
                clearTimeout(quietTimer);
                clearTimeout(capTimer);
                try { ws.close(); } catch (e) { /* ignore */ }
                if (err && !seen) { reject(err); } else { resolve(data); }
            }

            var capTimer = setTimeout(function () { finish(seen ? null : new Error(t('PILOT live connection did not answer.'))); }, 25000);

            try {
                ws = new WebSocket(wsUrl(), 'zap-protocol-v1');
            } catch (e) {
                finish(e);
                return;
            }
            ws.onopen = function () { ws.send(ids.join(',')); };
            ws.onerror = function () { finish(new Error(t('Could not open the PILOT live connection.'))); };
            ws.onclose = function () { finish(seen ? null : new Error(t('PILOT live connection closed.'))); };
            ws.onmessage = function (ev) {
                var arr;
                try { arr = JSON.parse(ev.data); } catch (e) {
                    if (/access denied/i.test(String(ev.data))) { finish(new Error(t('PILOT session is not signed in.'))); }
                    return;
                }
                if (!Ext.isArray(arr)) { arr = [arr]; }
                Ext.Array.forEach(arr, function (o) {
                    var id = o && Number(o.veh_id || o.id);
                    if (!id) { return; }
                    if (!data[id]) { data[id] = {}; seen++; }
                    if (Number(o.wasl) > 0) { data[id].wasl = Number(o.wasl); }
                    if (o.wasl_state) { data[id].wasl_state = o.wasl_state; }
                });
                if (seen >= need) { finish(); return; }
                clearTimeout(quietTimer);
                quietTimer = setTimeout(function () { finish(); }, 3000);
            };
        });
    }

    /** GET in this browser's PILOT session (fetch, because PILOT's Ext.Ajax prefixes URLs with base_url). */
    function ajaxJson(url, params) {
        return fetch(url + '?' + Ext.Object.toQueryString(params), { credentials: 'same-origin' }).then(function (r) {
            if (r.status === 401 || r.status === 403) { throw new Error(t('PILOT session is not signed in.')); }
            if (!r.ok) { throw new Error(t('PILOT request failed') + ' (HTTP ' + r.status + ')'); }
            return r.json().catch(function () { throw new Error(t('Unexpected answer from PILOT.')); });
        });
    }

    /* ------------------------------------------------------------------ data service */

    Ext.define('Store.wasl_status.Data', {
        extend: 'Ext.Base',
        mixins: ['Ext.mixin.Observable'],

        constructor: function (cfg) {
            this.mixins.observable.constructor.call(this, cfg);
            this.source = null;       // { mode: 'current' } | { mode: 'other', username, password }
            this.loading = false;
            this.rows = [];
            this.account = '';
            this.loadedAt = null;
            this.apiUrl = API_DEFAULT;
            var me = this;
            try {
                if (window.Pilot && Pilot.Extensions && Pilot.Extensions.getSettings) {
                    Pilot.Extensions.getSettings(EXT).then(function (s) {
                        if (s && s.api_url) { me.apiUrl = String(s.api_url).replace(/\/+$/, ''); }
                    }, function () { /* keep default */ });
                }
            } catch (e) { /* keep default */ }
        },

        currentUserName: function () {
            try {
                var c = window.global_conf && global_conf.conf,
                    u = window.CurrentUser && (CurrentUser.data || CurrentUser);
                return (c && c.org && c.org.org_name) || (u && u.accountName) || '';
            } catch (e) { return ''; }
        },

        load: function (source) {
            var me = this;
            if (source) { me.source = source; }
            if (!me.source || me.loading) { return; }
            me.loading = true;
            me.fireEvent('loading');
            var p = me.source.mode === 'other' ? me.loadOther() : me.loadCurrent();
            p.then(function (res) {
                me.loading = false;
                me.rows = res.rows;
                me.account = res.account;
                me.loadedAt = new Date();
                me.fireEvent('loaded', me);
            }, function (err) {
                me.loading = false;
                if (window.console) { console.warn(EXT + ': load failed', err); }
                me.fireEvent('failed', (err && err.message) || String(err));
            });
        },

        loadCurrent: function () {
            var me = this;
            return ajaxJson(pilotBase() + 'ax/tree.php', { vehs: 1, state: 2, node: 'root' }).then(function (tree) {
                var vehicles = vehiclesFromTree(tree);
                if (!vehicles.length) { return { rows: [], account: me.currentUserName() || t('Current account') }; }
                return collectWasl(Ext.Array.pluck(vehicles, 'id')).then(function (wasl) {
                    return { rows: buildRows(vehicles, wasl), account: me.currentUserName() || t('Current account') };
                });
            });
        },

        loadOther: function () {
            var me = this, s = me.source;
            return fetch(me.apiUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                credentials: 'omit',
                body: JSON.stringify({ username: s.username, password: s.password, host: location.origin })
            }).then(function (res) {
                return res.text().then(function (txt) {
                    var j = null;
                    try { j = JSON.parse(txt); } catch (e) { /* not JSON */ }
                    if (!res.ok || !j || j.error) {
                        if (j && j.error) { throw new Error(j.error); }
                        if (res.status === 404 || res.status === 405) {
                            throw new Error(t('The WASL Status backend is not reachable at') + ' ' + me.apiUrl +
                                '. ' + t('Set the extension setting api_url (see the extension documentation).'));
                        }
                        throw new Error(t('Backend error') + ' (HTTP ' + res.status + ')');
                    }
                    return { rows: buildRows(j.vehicles || [], j.wasl || {}), account: j.account || s.username };
                });
            });
        }
    });

    /* ------------------------------------------------------------------ account prompt */

    Ext.define('Store.wasl_status.view.AccountWindow', {
        extend: 'Ext.window.Window',
        title: t('WASL Status') + ' – ' + t('Choose account'),
        modal: true,
        width: 380,
        resizable: false,
        bodyPadding: 16,
        cls: 'ws-account-win',

        initComponent: function () {
            var me = this, cur = me.service.currentUserName(), prev = me.service.source || {};
            me.items = [{
                xtype: 'form',
                itemId: 'form',
                border: false,
                defaults: { anchor: '100%' },
                items: [{
                    xtype: 'radiogroup',
                    itemId: 'mode',
                    columns: 1,
                    vertical: true,
                    items: [
                        { boxLabel: t('Current account') + (cur ? ' (' + esc(cur) + ')' : ''), name: 'mode', inputValue: 'current', checked: prev.mode !== 'other' },
                        { boxLabel: t('Another account'), name: 'mode', inputValue: 'other', checked: prev.mode === 'other' }
                    ],
                    listeners: { change: function () { me.syncMode(); } }
                }, {
                    xtype: 'fieldcontainer',
                    itemId: 'creds',
                    layout: 'anchor',
                    defaults: { anchor: '100%', labelWidth: 80 },
                    items: [
                        { xtype: 'textfield', itemId: 'username', fieldLabel: t('Login'), value: prev.username || storageGet('username', ''), allowBlank: false,
                          inputAttrTpl: 'autocomplete="off" data-lpignore="true"' },
                        { xtype: 'textfield', itemId: 'password', fieldLabel: t('Password'), inputType: 'password', allowBlank: false,
                          inputAttrTpl: 'autocomplete="new-password" data-lpignore="true"',
                          listeners: { specialkey: function (f, e) { if (e.getKey() === e.ENTER) { me.submit(); } } } },
                        { xtype: 'component', cls: 'ws-note', html: t('The sign-in is done by the extension, your PILOT session stays as it is. The password is not saved.') }
                    ]
                }]
            }];
            me.buttons = [
                { text: t('Cancel'), handler: function () { me.close(); } },
                { text: t('Show'), iconCls: 'fa fa-check', handler: function () { me.submit(); } }
            ];
            me.callParent(arguments);
            me.on('afterrender', me.syncMode, me);
        },

        mode: function () {
            var v = this.down('#mode').getValue();
            return v && v.mode === 'other' ? 'other' : 'current';
        },

        syncMode: function () {
            var other = this.mode() === 'other', c = this.down('#creds');
            c.setHidden(!other);
            c.query('textfield').forEach(function (f) { f.setDisabled(!other); });
            if (other) { Ext.defer(function () { var u = this.down('#username'); (u.getValue() ? this.down('#password') : u).focus(); }, 50, this); }
            this.updateLayout();
        },

        submit: function () {
            var me = this;
            if (me.mode() === 'current') {
                me.onChoose({ mode: 'current' });
                me.close();
                return;
            }
            var u = Ext.String.trim(me.down('#username').getValue() || ''), p = me.down('#password').getValue() || '';
            if (!u || !p) {
                me.down('#username').validate();
                me.down('#password').validate();
                return;
            }
            storageSet('username', u);
            me.onChoose({ mode: 'other', username: u, password: p });
            me.close();
        }
    });

    /* ------------------------------------------------------------------ left panel */

    Ext.define('Store.wasl_status.view.Nav', {
        extend: 'Ext.panel.Panel',
        layout: { type: 'vbox', align: 'stretch' },
        bodyPadding: 12,
        scrollable: 'y',
        cls: 'ws-nav',

        initComponent: function () {
            var me = this;
            me.items = [
                { xtype: 'component', itemId: 'account', cls: 'ws-account', html: '' },
                {
                    xtype: 'container', layout: { type: 'hbox' }, margin: '8 0 12 0',
                    items: [
                        { xtype: 'button', text: t('Change account'), iconCls: 'fa fa-user', flex: 1, margin: '0 6 0 0', handler: function () { me.module.promptAccount(); } },
                        { xtype: 'button', itemId: 'refresh', text: t('Refresh'), iconCls: 'fa fa-rotate', flex: 1, handler: function () { me.module.service.load(); } }
                    ]
                },
                { xtype: 'component', itemId: 'summary', html: '' },
                {
                    xtype: 'segmentedbutton', itemId: 'filter', margin: '12 0 8 0', allowMultiple: false,
                    items: [
                        { text: t('All'), value: 'all', pressed: true },
                        { text: t('Connected'), value: 'on' },
                        { text: t('Not connected'), value: 'off' }
                    ],
                    listeners: { change: function (b, v) { me.main.setFilter({ state: v }); } }
                },
                { xtype: 'textfield', emptyText: t('Search vehicle, plate, group…'), listeners: { change: function (f, v) { me.main.setFilter({ text: v }); }, buffer: 200 } },
                { xtype: 'component', itemId: 'status', cls: 'ws-muted', margin: '10 0 0 0', html: '' }
            ];
            me.callParent(arguments);
            var s = me.module.service;
            s.on('loading', function () { me.setStatus('<i class="fa fa-spinner fa-spin"></i> ' + t('Loading…')); me.down('#refresh').disable(); });
            s.on('loaded', function () { me.down('#refresh').enable(); me.renderInfo(); });
            s.on('failed', function (msg) { me.down('#refresh').enable(); me.setStatus('<span class="ws-err">' + esc(msg) + '</span>'); });
            me.renderInfo();
        },

        setStatus: function (html) { this.down('#status').setHtml(html); },

        renderInfo: function () {
            var s = this.module.service, src = s.source;
            this.down('#account').setHtml(src
                ? '<div class="ws-muted">' + t('Account') + '</div><div class="ws-account-name">' + esc(s.account || (src.mode === 'other' ? src.username : t('Current account'))) +
                  (src.mode === 'other' ? ' <span class="ws-tag">' + t('other') + '</span>' : '') + '</div>'
                : '<div class="ws-muted">' + t('No account chosen yet.') + '</div>');
            var total = s.rows.length, on = 0;
            Ext.Array.forEach(s.rows, function (r) { on += r.connected; });
            this.down('#summary').setHtml(src && s.loadedAt
                ? '<div class="ws-tiles">' +
                  '<div class="ws-tile"><b>' + total + '</b><span>' + t('Vehicles') + '</span></div>' +
                  '<div class="ws-tile ws-on"><b>' + on + '</b><span>' + t('Connected') + '</span></div>' +
                  '<div class="ws-tile ws-off"><b>' + (total - on) + '</b><span>' + t('Not connected') + '</span></div></div>'
                : '');
            this.setStatus(s.loadedAt ? t('Updated') + ' ' + Ext.Date.format(s.loadedAt, 'H:i:s') : '');
        }
    });

    /* ------------------------------------------------------------------ main grid */

    Ext.define('Store.wasl_status.view.Main', {
        extend: 'Ext.grid.Panel',
        cls: 'ws-grid',
        columnLines: true,
        emptyText: '<div class="ws-empty">' + t('Choose an account to show the WASL status of its vehicles.') + '</div>',

        initComponent: function () {
            var me = this;
            me.filterState = 'all';
            me.filterText = '';
            me.store = Ext.create('Ext.data.Store', {
                fields: ['id', 'name', 'plate', 'group', 'imei', { name: 'wasl', type: 'int', allowNull: true }, 'response', { name: 'connected', type: 'int' }],
                sorters: [{ property: 'name', direction: 'ASC', sorterFn: naturalName }],
                data: []
            });
            me.tbar = [
                { xtype: 'tbtext', itemId: 'title', html: '<b>' + t('WASL Status') + '</b>' },
                '->',
                { xtype: 'button', text: t('Export CSV'), iconCls: 'fa fa-file-csv', handler: function () { me.exportCsv(); } }
            ];
            me.columns = [
                { xtype: 'rownumberer', width: 50 },
                { text: t('Vehicle'), dataIndex: 'name', flex: 1, minWidth: 110, renderer: esc },
                { text: t('Plate'), dataIndex: 'plate', width: 120, renderer: esc },
                { text: t('Group'), dataIndex: 'group', width: 140, renderer: esc },
                { text: t('IMEI'), dataIndex: 'imei', width: 150, hidden: true, renderer: esc },
                {
                    text: t('WASL'), dataIndex: 'wasl', width: 150, align: 'center',
                    renderer: function (v, meta) {
                        if (!v) { return '<span class="ws-muted">—</span>'; }
                        meta.tdAttr = 'data-qtip="' + esc(fmtAge(v)) + '"';
                        var fresh = (Date.now() / 1000 - v) <= FRESH_SECONDS;
                        return '<span class="ws-time ' + (fresh ? 'ws-time-on' : 'ws-time-off') + '">' + esc(fmtTime(v)) + '</span>';
                    }
                },
                {
                    text: t('WASL State'), dataIndex: 'connected', width: 140, align: 'center',
                    renderer: function (v) {
                        return v ? '<span class="ws-badge ws-badge-on">' + t('Connected') + '</span>'
                                 : '<span class="ws-badge ws-badge-off">' + t('Not connected') + '</span>';
                    }
                },
                {
                    text: t('WASL Response'), dataIndex: 'response', width: 200,
                    renderer: function (v) { return v ? esc(v) : '<span class="ws-muted">—</span>'; }
                }
            ];
            me.callParent(arguments);
            var s = me.module.service;
            s.on('loading', function () { me.setLoading(t('Loading WASL status…')); });
            s.on('loaded', function () { me.setLoading(false); me.fill(); });
            s.on('failed', function (msg) {
                me.setLoading(false);
                Ext.Msg.alert(t('WASL Status'), esc(msg));
            });
        },

        fill: function () {
            var s = this.module.service;
            this.store.loadData(s.rows);
            this.store.sort();
            this.applyFilter();
            this.down('#title').setHtml('<b>' + t('WASL Status') + '</b> &nbsp;·&nbsp; ' + esc(s.account));
        },

        setFilter: function (f) {
            if (f.state !== undefined) { this.filterState = f.state || 'all'; }
            if (f.text !== undefined) { this.filterText = String(f.text || '').trim().toLowerCase(); }
            this.applyFilter();
        },

        applyFilter: function () {
            var st = this.filterState, q = this.filterText;
            this.store.clearFilter(true);
            this.store.filterBy(function (r) {
                if (st === 'on' && !r.get('connected')) { return false; }
                if (st === 'off' && r.get('connected')) { return false; }
                if (q) {
                    var hay = [r.get('name'), r.get('plate'), r.get('group'), r.get('imei'), r.get('response')].join(' ').toLowerCase();
                    if (hay.indexOf(q) === -1) { return false; }
                }
                return true;
            });
        },

        exportCsv: function () {
            var rows = [['Vehicle', 'Plate', 'Group', 'IMEI', 'WASL', 'WASL State', 'WASL Response']];
            this.store.each(function (r) {
                rows.push([r.get('name'), r.get('plate'), r.get('group'), r.get('imei'),
                    r.get('wasl') ? fmtTime(r.get('wasl')) : '', r.get('connected') ? 'Connected' : 'Not connected', r.get('response')]);
            });
            var csv = '﻿' + rows.map(function (row) {
                return row.map(function (c) {
                    c = c === null || c === undefined ? '' : String(c);
                    return /[",\n;]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
                }).join(',');
            }).join('\r\n');
            var a = document.createElement('a'), url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
            a.href = url;
            a.download = 'wasl_status_' + Ext.Date.format(new Date(), 'Y-m-d_H-i') + '.csv';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        }
    });

    /* ------------------------------------------------------------------ module entry */

    Ext.define('Store.wasl_status.Module', {
        extend: 'Ext.Component',
        extensionName: EXT,

        initModule: function () {
            var me = this;
            if (window.console) { console.log(EXT + ': initModule() v' + VERSION); }

            if (!window.skeleton || !skeleton.navigation || !skeleton.navigation.add) {
                if (window.console) { console.warn(EXT + ': skeleton.navigation not found'); }
                return;
            }
            var frame = skeleton.mapframe || skeleton.map_frame;
            if (!frame || !frame.add) {
                if (window.console) { console.warn(EXT + ': skeleton.mapframe not found'); }
                return;
            }
            try {
                me.buildUi(frame);
            } catch (e) {
                if (window.console) { console.error(EXT + ': failed to build the UI', e); }
            }
        },

        getModuleBaseUrl: function () {
            var scripts = document.getElementsByTagName('script');
            for (var i = scripts.length - 1; i >= 0; i--) {
                var src = scripts[i].src || '';
                if (src.indexOf('/' + EXT + '/Module.js') !== -1) { return src.substring(0, src.lastIndexOf('/') + 1); }
            }
            return '/store/' + EXT + '/';
        },

        loadStyles: function () {
            var href = this.getModuleBaseUrl() + 'style.css?v=' + VERSION;
            if (document.querySelector('link[data-ext="' + EXT + '"]')) { return; }
            var el = document.createElement('link');
            el.rel = 'stylesheet';
            el.href = href;
            el.setAttribute('data-ext', EXT);
            document.head.appendChild(el);
        },

        buildUi: function (frame) {
            var me = this;
            me.loadStyles();
            me.service = Ext.create('Store.wasl_status.Data', {});
            me.mainPanel = Ext.create('Store.wasl_status.view.Main', { module: me });

            var LeftTabClass = Ext.ClassManager.get('Pilot.utils.LeftBarPanel') ? 'Pilot.utils.LeftBarPanel' : 'Ext.panel.Panel';
            me.navTab = Ext.create(LeftTabClass, {
                title: t('WASL Status'),
                tooltip: t('WASL Status'),
                iconCls: 'fa fa-tower-broadcast',
                iconAlign: 'top',
                minimized: true,
                cls: 'tab_clipped leftbarpanel ws-navtab',
                bodyCls: 'left_top_round',
                items: [Ext.create('Store.wasl_status.view.Nav', { title: t('WASL Status'), iconCls: 'fa fa-tower-broadcast', module: me, main: me.mainPanel })]
            });
            me.navTab.map_frame = me.mainPanel;

            skeleton.navigation.add(me.navTab);
            frame.add(me.mainPanel);

            var first = function () { if (!me.service.source && !me.prompting) { me.promptAccount(); } };
            me.navTab.on('activate', first);
            me.mainPanel.on('activate', first);
            me.mainPanel.on('show', first);
        },

        promptAccount: function () {
            var me = this;
            me.prompting = true;
            Ext.create('Store.wasl_status.view.AccountWindow', {
                service: me.service,
                onChoose: function (src) { me.service.load(src); },
                listeners: { close: function () { me.prompting = false; } }
            }).show();
        }
    });
})();
