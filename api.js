(function () {
    if (typeof window === 'undefined' || !window.NativeHttp || window.__nativeHttpInstalled) return;
    window.__nativeHttpInstalled = true;

    var origFetch = window.fetch.bind(window);
    var pending = {};
    var seq = 0;

    window.__nativeHttpDone = function (id, b64) {
        var p = pending[id];
        if (!p) return;
        delete pending[id];
        try {
            var bin = atob(b64), bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            p.resolve(JSON.parse(new TextDecoder('utf-8').decode(bytes)));
        } catch (e) { p.reject(e); }
    };

    function isKickUrl(u) {
        try {
            var h = new URL(u, location.href).hostname;
            return h === 'kick.com' || h.slice(-9) === '.kick.com';
        } catch (e) { return false; }
    }

    function normHeaders(h) {
        var out = {};
        if (!h) return out;
        if (typeof Headers !== 'undefined' && h instanceof Headers) { h.forEach(function (v, k) { out[k] = v; }); return out; }
        if (Array.isArray(h)) { h.forEach(function (kv) { out[kv[0]] = kv[1]; }); return out; }
        for (var k in h) out[k] = h[k];
        return out;
    }

    window.fetch = function (input, init) {
        var url = (typeof input === 'string') ? input : (input && input.url);
        if (!url || !isKickUrl(url)) return origFetch(input, init);
        init = init || {};

        var body = init.body;
        if (body != null) {
            if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) body = body.toString();
            if (typeof body !== 'string') return origFetch(input, init); // FormData/Blob: نادر هنا
        }

        var id = ++seq;
        var sig = init.signal;

        return new Promise(function (resolve, reject) {
            if (sig && sig.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }

            if (sig) {
                sig.addEventListener('abort', function () {
                    if (!pending[id]) return;
                    delete pending[id];
                    try { window.NativeHttp.cancel(id); } catch (e) {}
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            }

            pending[id] = {
                reject: reject,
                resolve: function (r) {
                    if (r.error || !r.status) { reject(new TypeError('Network request failed: ' + (r.error || 'no response'))); return; }
                    var nullBody = (r.status === 204 || r.status === 205 || r.status === 304);
                    var hdrs = new Headers();
                    for (var k in (r.headers || {})) { try { hdrs.append(k, r.headers[k]); } catch (e) {} }
                    resolve(new Response(nullBody ? null : (r.body || ''), { status: r.status, statusText: r.statusText || '', headers: hdrs }));
                }
            };

            try {
                window.NativeHttp.request(id, JSON.stringify({
                    url: new URL(url, location.href).href,
                    method: String(init.method || 'GET').toUpperCase(),
                    headers: normHeaders(init.headers),
                    body: body == null ? null : body,
                    timeout: init.timeout || 15000
                }));
            } catch (e) { delete pending[id]; reject(e); }
        });
    };
})();
/* ===== end Native HTTP bridge ===== */

var KICK_BASE = 'https://kick.com';
var $ = function(id) { return document.getElementById(id); };

var PROXY_ENABLED        = false;
var PROXY_DIRECT_FIRST   = true;
var PROXY_TIMEOUT        = 15000;
var PROXY_MAX_TRIES      = 1;
var PROXY_TOTAL_BUDGET   = 20000;

var KB_PROXIES = [];

var _bestProxy = -1;
function saveBestProxy() { _bestProxy = -1; }

var _proxyFailCount = {};

function _kbCountOk(i)   { if (typeof i === 'number') { _proxyFailCount[i] = 0; if (i >= 0) _bestProxy = i; } }
function _kbCountFail(i) { if (typeof i === 'number') { _proxyFailCount[i] = (_proxyFailCount[i] || 0) + 1; } }

function _kbProxyOrder(preferred) {
    var order = [], i;
    if (typeof preferred === 'number' && preferred >= 0 && preferred < KB_PROXIES.length) order.push(preferred);
    for (i = 0; i < KB_PROXIES.length; i++) { if (order.indexOf(i) === -1) order.push(i); }
    return order;
}

function _mkRes(text, status, headers) {
    status = (typeof status === 'number' && status) ? status : 200;
    var h = headers || {};
    return {
        ok: status >= 200 && status < 300,
        status: status,
        statusText: '',
        headers: { get: function(k){ k = String(k || '').toLowerCase(); return (h[k] !== undefined ? h[k] : null); } },
        text: function(){ return Promise.resolve(String(text == null ? '' : text)); },
        json: function(){ return Promise.resolve(JSON.parse(String(text == null ? '' : text))); }
    };
}

function _kbIsProxyOwnError(res, bodySample) {
    var t = String(bodySample || '').toLowerCase();
    if (!t) return false;
    if (/a valid api key is required|rate limit exceeded|too many requests|quota exceeded|upgrade your plan|missing api key|proxy error|not allowed without/.test(t)) return true;
    if (/error code: 10\d\d/.test(t)) return true;
    if (t.indexOf('proxy') !== -1 && /(disabled|blocked|denied|abuse|limit|invalid|forbidden)/.test(t)) return true;
    if (t.indexOf('cloudflare') !== -1 && res && (res.status === 403 || res.status === 429)) return true;
    return false;
}

var xsrfToken = '';
var isDirectMode = false;

function detectMode() {
    try {
        isDirectMode = window.location.hostname === 'kick.com' || window.location.hostname.endsWith('.kick.com');
    } catch(e) { isDirectMode = false; }
}

async function fetchWithTimeout(url, opts, timeout) {
    timeout = timeout || PROXY_TIMEOUT;
    if (typeof AbortController === 'undefined') {
        return await Promise.race([
            fetch(url, opts),
            new Promise(function(_, reject) { setTimeout(function() { reject(new Error('timeout')); }, timeout); })
        ]);
    }
    var ctrl = new AbortController();
    var timer = setTimeout(function() { try { ctrl.abort(); } catch(e) {} }, timeout);
    try {
        var o = Object.assign({}, opts);
        o.signal = ctrl.signal;
        return await fetch(url, o);
    } finally { clearTimeout(timer); }
}

async function smartFetch(url, options, preferredProxy) {
    options = options || {};
    var isPost = String(options.method || 'GET').toUpperCase() !== 'GET';
    var timeout = options.timeout || PROXY_TIMEOUT;

    var opts = Object.assign({}, options);
    delete opts.timeout;
    delete opts.preferredProxy;

    try {
        if (opts.body && typeof URLSearchParams !== 'undefined' && opts.body instanceof URLSearchParams) {
            opts.body = opts.body.toString();
        }
    } catch(e) {}

    var attempts = [];
    if (!PROXY_ENABLED) {
        attempts.push({ idx:-1, name:'direct' });
    } else {
        if (PROXY_DIRECT_FIRST) attempts.push({ idx:-1, name:'direct' });
        var order = _kbProxyOrder(preferredProxy);
        for (var i = 0; i < order.length; i++) {
            if (attempts.length >= (PROXY_MAX_TRIES + 1)) break;
            attempts.push({ idx: order[i], name: KB_PROXIES[order[i]].name });
        }
        if (!PROXY_DIRECT_FIRST) attempts.push({ idx:-1, name:'direct' });
    }

    var started  = Date.now();
    var lastRes  = null;
    var lastErr  = null;
    var lastIdx  = -1;

    for (var a = 0; a < attempts.length; a++) {
        var at = attempts[a];
        if (a > 0 && (Date.now() - started) > PROXY_TOTAL_BUDGET) break;

        var target = url;
        if (at.idx >= 0) {
            var px = KB_PROXIES[at.idx];
            if (!px) continue;
            if (isPost && !px.post) continue;
            try { target = px.build(url); } catch(e) { continue; }
        }

        var o = Object.assign({}, opts);
        if (at.idx >= 0) { o.credentials = 'omit'; o.cache = 'no-store'; }

        var r;
        try {
            r = await fetchWithTimeout(target, o, timeout);
        } catch(e) {
            lastErr = e; lastIdx = at.idx;
            if (at.idx >= 0) _kbCountFail(at.idx);
            continue;
        }

        if (at.idx >= 0 && KB_PROXIES[at.idx].wrapper) {
            try {
                var wrappedTxt = (typeof r.clone === 'function') ? await r.clone().text() : await r.text();
                var j = JSON.parse(wrappedTxt);
                var code = 200;
                try { code = parseInt((j && j.status && (j.status.http_code || j.status.httpCode)) || 200, 10) || 200; } catch(e2) {}
                r = _mkRes((j && j.contents != null) ? j.contents : '', code);
            } catch(e) {
                _kbCountFail(at.idx); lastErr = e; lastIdx = at.idx; continue;
            }
        }

        if (r && r.ok) { _kbCountOk(at.idx); return { res: r, proxyUsed: at.idx, ok: true }; }

        if (at.idx >= 0) {
            var sample = '';
            try {
                if (typeof r.clone === 'function') sample = String(await r.clone().text() || '').slice(0, 400);
            } catch(e) {}
            if (_kbIsProxyOwnError(r, sample)) { _kbCountFail(at.idx); lastRes = r; lastIdx = at.idx; continue; }
        }

        lastRes = r; lastIdx = at.idx;
        if (r && (r.status === 401 || r.status === 403 || r.status === 404 || r.status === 419 || r.status === 422 || r.status === 429)) {
            return { res: r, proxyUsed: at.idx, ok: false };
        }
    }

    if (lastRes) return { res: lastRes, proxyUsed: lastIdx, ok: false };
    return { res: null, proxyUsed: -1, ok: false, error: lastErr || new Error('all_proxies_failed') };
}

async function proxiedFetch(kickPath, options) {
    options = options || {};
    var method = options.method || 'GET';
    var body = options.body || null;
    var headers = options.headers || {};
    var timeout = options.timeout || PROXY_TIMEOUT;
    var skipAuth = options.skipAuth || false;
    var token = options.token || '';
    var isPost = (method !== 'GET');
    var preferred = (typeof options.preferredProxy === 'number') ? options.preferredProxy : _bestProxy;

    var defHeaders = { 'Accept':'application/json' };
    if (isPost) defHeaders['Content-Type'] = 'application/json';
    defHeaders['Origin'] = KICK_BASE;
    if (!skipAuth && token) defHeaders['Authorization'] = 'Bearer ' + token;
    if (xsrfToken) defHeaders['X-XSRF-TOKEN'] = xsrfToken;
    for (var k in headers) defHeaders[k] = headers[k];

    var fetchOpts = { method:method, headers:defHeaders, credentials:isDirectMode ? 'include' : 'omit', timeout:timeout };
    if (body && isPost) fetchOpts.body = JSON.stringify(body);

    var out = await smartFetch(KICK_BASE + kickPath, fetchOpts, preferred);
    if (out && out.res) {
        if (out.proxyUsed >= 0) _bestProxy = out.proxyUsed;
        return { res: out.res, proxyUsed: out.proxyUsed };
    }
    throw (out && out.error) || new Error('فشل الاتصال');
}

async function kbTestProxies() {
    var testUrl = KICK_BASE + '/api/v1/ping';
    var report = [];
    var list = [{ name:'direct', build:function(u){ return u; } }].concat(KB_PROXIES);
    for (var i = 0; i < list.length; i++) {
        var px = list[i], target = testUrl, t0 = Date.now();
        try {
            target = px.build(testUrl);
            var r = await fetchWithTimeout(target, { method:'GET', cache:'no-store' }, PROXY_TIMEOUT);
            report.push({ proxy: px.name, status: r.status, ok: r.ok, ms: Date.now() - t0, url: target });
        } catch(e) {
            report.push({ proxy: px.name, status: 0, ok: false, ms: Date.now() - t0, error: String(e && e.message || e), url: target });
        }
    }
    try { console.table ? console.table(report) : console.log(report); } catch(e) { console.log(report); }
    return report;
}
try { window.kbTestProxies = kbTestProxies; window.KB_PROXIES = KB_PROXIES; } catch(e) {}

function _readCookie(name) {
    try {
        var parts = String(document.cookie || '').split(';');
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            if (p.indexOf(name + '=') === 0) return decodeURIComponent(p.substring(name.length + 1));
        }
    } catch(e) {}
    return '';
}

async function fetchXsrf() {
    xsrfToken = '';
    try {
        try { await proxiedFetch('/sanctum/csrf-cookie', {skipAuth:true, timeout:8000}); } catch(e){}
        var pr = await proxiedFetch('/', {skipAuth:true, timeout:8000});
        if (pr.res.ok) {
            var html = await pr.res.text(); var m;
            m = html.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i);
            if (m) { xsrfToken=m[1]; return; }
            m = html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i);
            if (m) { xsrfToken=m[1]; return; }
            m = html.match(/"csrf[^"]*"\s*:\s*"([^"]+)"/i);
            if (m) { xsrfToken=m[1]; return; }
        }
    } catch(e){}
    var c = _readCookie('XSRF-TOKEN');
    if (c) xsrfToken = c;
}

async function refreshXsrf() { xsrfToken=''; await fetchXsrf(); }

async function sendMessage(chatroomId, content, token, preferredProxy) {
    var endpoints = [
        { path:'/api/v2/messages/send/'+chatroomId, body:{content:content, type:'message'} },
        { path:'/api/v1/chat-messages', body:{content:content, chatroom_id:parseInt(chatroomId)} }
    ];
    var lastErr = null;
    var firstErr = null;
    var statusCounts = {};
    var xsrfRefreshed = false;

    for (var ei = 0; ei < endpoints.length; ei++) {
        var ep = endpoints[ei];
        for (var attempt = 0; attempt < 2; attempt++) {
            try {
                var r = await proxiedFetch(ep.path, {
                    method:'POST', token:token, timeout:10000, body:ep.body
                });
                if (r.res.ok) { return { success:true, proxyUsed:-1 }; }
                var st = r.res.status;
                if (st === 419) {
                    if (!xsrfRefreshed) { xsrfRefreshed = true; try { await refreshXsrf(); } catch(e){} continue; }
                    lastErr = new Error('HTTP 419');
                    break;
                }
                if (st === 429) {

                    var ra = 0;
                    try { ra = parseInt(r.res.headers.get('Retry-After') || '', 10) || 0; } catch(e){}
                    var e429 = new Error('حد السرعة');
                    e429.status = 429; e429.retryAfter = ra;
                    throw e429;
                }
                if (st === 401 || st === 403) {
                    statusCounts[st] = (statusCounts[st] || 0) + 1;
                }
                lastErr = new Error('HTTP '+st);
                if (!firstErr) firstErr = lastErr;
                break;
            } catch(e) {
                if (e && e.status === 429) throw e;
                lastErr = e;
                if (!firstErr) firstErr = e;
                break;
            }
        }
    }

    if (statusCounts[403] >= 2) throw new Error('لا صلاحية');
    if (statusCounts[401] >= 2) throw new Error('توكن منتهي');
    var fe = firstErr || lastErr;
    if (fe instanceof TypeError || (fe && fe.message && fe.message.indexOf('Failed to fetch')>=0)) throw new Error('خطأ اتصال');
    throw fe || new Error('فشل الإرسال');
}

async function fetchChannel(slug, acc) {
    slug = slug.trim().toLowerCase().replace(/^\/+|\/+$|\s+/g, '');
    if (!slug) throw new Error('اسم القناة فارغ');
    if (!acc) acc = { workingProxy:-1 };

    var lastErr = null;

    var foundButInvalid = false;

    try {
        var r1 = await proxiedFetch('/api/v2/channels/'+slug, {skipAuth:true, timeout:8000, preferredProxy:acc.workingProxy});
        if (r1.res.ok) {
            acc.workingProxy = r1.proxyUsed;
            var data = await r1.res.json().catch(function(){return null;});
            if (data) {
                var dd = data.data || data;
                if (dd.id || dd.chatroom_id || dd.chatroom || dd.slug) return data;
            }
            foundButInvalid = true;
            _proxyFailCount[r1.proxyUsed] = (_proxyFailCount[r1.proxyUsed] || 0) + 1;
        } else if (r1.res.status === 404) {
            throw new Error('NOT_FOUND');
        }
    } catch(e) {
        if (e.message === 'NOT_FOUND') throw e;
        lastErr = e;
    }

    try {
        var r2 = await proxiedFetch('/api/v1/channels/'+slug, {skipAuth:true, timeout:8000, preferredProxy:acc.workingProxy});
        if (r2.res.ok) {
            acc.workingProxy = r2.proxyUsed;
            var data2 = await r2.res.json().catch(function(){return null;});
            if (data2) {
                var dd2 = data2.data || data2;
                if (dd2.id || dd2.chatroom_id || dd2.chatroom || dd2.slug) return data2;
            }
            foundButInvalid = true;
            _proxyFailCount[r2.proxyUsed] = (_proxyFailCount[r2.proxyUsed] || 0) + 1;
        } else if (r2.res.status === 404) {
            throw new Error('NOT_FOUND');
        }
    } catch(e) {
        if (e.message === 'NOT_FOUND') throw e;
        lastErr = e;
    }

    try {
        var r3 = await proxiedFetch('/api/search?q='+encodeURIComponent(slug), {skipAuth:true, timeout:8000, preferredProxy:acc.workingProxy});
        if (r3.res.ok) {
            acc.workingProxy = r3.proxyUsed;
            var searchData = await r3.res.json().catch(function(){return null;});
            if (searchData) {
                var items = searchData.data || searchData;
                if (Array.isArray(items)) {
                    for (var i = 0; i < items.length; i++) {
                        var item = items[i];
                        if (item.slug === slug || item.username === slug) return item;
                        if (item.slug && item.slug.indexOf(slug) === 0) return item;
                    }
                    if (items.length > 0 && items[0].slug) return items[0];
                }
            }
            foundButInvalid = true;
            _proxyFailCount[r3.proxyUsed] = (_proxyFailCount[r3.proxyUsed] || 0) + 1;
        }
    } catch(e) {
        lastErr = e;
    }

    if (lastErr) {
        throw new Error('CONNECTION_ERROR');
    }
    if (foundButInvalid) {
        throw new Error('CONNECTION_ERROR');
    }
    throw new Error('NOT_FOUND');
}

function extractChatroomId(ch) {
    if (!ch) return null;
    var data = ch.data || ch;
    if (data.chatroom_id) return String(data.chatroom_id);
    if (data.chatroom) {
        if (typeof data.chatroom === 'object') {
            if (data.chatroom.id) return String(data.chatroom.id);
            if (data.chatroom.chatroom_id) return String(data.chatroom.chatroom_id);
        }
        return String(data.chatroom);
    }
    if (data.chatroomId) return String(data.chatroomId);
    return null;
}

async function fetchChatroomId(slug, acc) {
    slug = slug.trim().toLowerCase();
    try {
        var r1 = await proxiedFetch('/api/v2/channels/'+slug+'/chatroom', {skipAuth:true, timeout:8000, preferredProxy:acc.workingProxy, requireOk:true});
        if (r1.res.ok) {
            acc.workingProxy=r1.proxyUsed;
            var d = await r1.res.json().catch(function(){return null;});
            if (d) {
                var dd = d.data || d;
                if (dd.id) return String(dd.id);
                if (dd.chatroom_id) return String(dd.chatroom_id);
            }
        }
    } catch(e){}
    try {
        var chData = await fetchChannel(slug, acc);
        var cid = extractChatroomId(chData);
        if (cid) return cid;
    } catch(e){}
    return null;
}

var _liveCache = {}, _liveInflight = null;
function _allSlugVariants() {
    var out = [];
    try {
        accounts.forEach(function(a){ (a.channels || []).forEach(function(c){
            out.push(c.slug);
            if (c.slug.indexOf('-') !== -1) out.push(c.slug.replace(/-/g, '_'));
            if (c.slug.indexOf('_') !== -1) out.push(c.slug.replace(/_/g, '-'));
        }); });
    } catch (e) {}
    return out;
}
async function _refreshLiveCache(extra) {
    if (_liveInflight) return _liveInflight;
    _liveInflight = (async function() {
        try {
            var list = _allSlugVariants().concat(extra || []);
            var res = await kickLiveBatchOfficial(list);
            var now = Date.now();
            Object.keys(res).forEach(function(k){ _liveCache[k] = { v: res[k], t: now }; });
        } catch (e) {}
        finally { _liveInflight = null; }
    })();
    return _liveInflight;
}

async function checkChannelLive(slug, acc) {
    var _ck = _slugLoose(slug);
    var _c = _liveCache[_ck];
    if (!_c || Date.now() - _c.t > 20000) {
        await _refreshLiveCache([slug]);
        _c = _liveCache[_ck];
    }
    if (_c && Date.now() - _c.t <= 20000) return _c.v;
    try {
        var _vs = [slug];
        if (slug.indexOf('-') !== -1) _vs.push(slug.replace(/-/g, '_'));
        if (slug.indexOf('_') !== -1) _vs.push(slug.replace(/_/g, '-'));
        var off = await kickLiveBatchOfficial(_vs);
        var ok = _slugLoose(slug);
        if (Object.prototype.hasOwnProperty.call(off, ok)) return off[ok];
    } catch (e) {}
    var variants = [slug];
    if (slug.indexOf('-') !== -1) variants.push(slug.replace(/-/g, '_'));
    if (slug.indexOf('_') !== -1) variants.push(slug.replace(/_/g, '-'));
    for (var vi = 0; vi < variants.length; vi++) {
        var v = await _checkChannelLiveOne(variants[vi], acc);
        if (v === true || v === false) return v;
    }
    return null;
}

async function _checkChannelLiveOne(slug, acc) {
    try {
        var r = await proxiedFetch('/api/v2/channels/'+encodeURIComponent(slug)+'?_='+Date.now(), {skipAuth:true, timeout:8000, preferredProxy:acc.workingProxy, requireOk:true});
        if (r.res.ok) {
            var data = await r.res.json().catch(function(){return null;});
            if (data && typeof data === 'object') {
                var dd = data.data || data;
                if (dd.livestream === null) return false;
                if (dd.livestream && typeof dd.livestream === 'object') {
                    if (dd.livestream.is_live !== undefined) return dd.livestream.is_live === true;
                    return true;
                }
                if (dd.live_stream === null) return false;
                if (dd.live_stream && typeof dd.live_stream === 'object') {
                    if (dd.live_stream.is_live !== undefined) return dd.live_stream.is_live === true;
                    return true;
                }
                if (dd.is_live !== undefined) return dd.is_live === true;
                return null;
            }
        }
    } catch(e) {}
    return null;
}

var _livePollBusy = false;

async function kickLiveBatchOfficial(slugs) {
    var out = {};
    for (var i = 0; i < slugs.length; i += 50) {
        var chunk = slugs.slice(i, i + 50);
        var qs = chunk.map(function(x){ return 'slug=' + encodeURIComponent(x); }).join('&');
        for (var attempt = 0; attempt < 2; attempt++) {
            try {
                var token = await kickGetApiToken(attempt === 1);
                var _bo = await smartFetch('https://api.kick.com/public/v1/channels?' + qs, {
                    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
                    timeout: 10000
                }, _bestProxy);
                var r = _bo && _bo.res;
                if (!r) break;
                if (r.status === 401 && attempt === 0) { _kickAppToken = null; try { sessionStorage.removeItem('kick_access_token'); } catch (e) {} continue; }
                if (!r.ok) break;
                var d = await r.json().catch(function(){ return null; });
                var list = d && d.data;
                if (list && !Array.isArray(list)) list = [list];
                if (list) {
                    for (var k = 0; k < list.length; k++) {
                        var it = list[k];
                        if (!it || !it.slug) continue;
                        out[_slugLoose(it.slug)] = !!out[_slugLoose(it.slug)] || !!(it.stream && it.stream.is_live === true);
                    }
                }
                break;
            } catch (e) { break; }
        }
    }
    return out;
}

async function pollChannelsLiveStatus(b) {
    if (!b || !b.channels || b.channels.length === 0) return;
    if (_livePollBusy) return;
    _livePollBusy = true;
    try {
        var chans = b.channels.slice();
        var pending = [];

        var official = {};
        try { var _pl = [];
            chans.forEach(function(c){
                _pl.push(c.slug);
                if (c.slug.indexOf('-') !== -1) _pl.push(c.slug.replace(/-/g, '_'));
                if (c.slug.indexOf('_') !== -1) _pl.push(c.slug.replace(/_/g, '-'));
            });
            official = await kickLiveBatchOfficial(_pl);
            Object.keys(official).forEach(function(k){ _liveCache[k] = { v: official[k], t: Date.now() }; }); } catch (e) { official = {}; }
        for (var i = 0; i < chans.length; i++) {
            var key = _slugLoose(chans[i].slug);
            if (Object.prototype.hasOwnProperty.call(official, key)) chans[i].isLive = official[key];
            else pending.push(chans[i]);
        }
        if (activeModalBotId === b.id) renderChannelsList(b);

        var idx = 0;
        var workers = [];
        var worker = async function() {
            while (idx < pending.length) {
                var ch = pending[idx++];
                try {
                    var live = await checkChannelLive(ch.slug, b);
                    if (live !== null) ch.isLive = live;
                } catch (e) {}
            }
        };
        for (var w = 0; w < Math.min(4, pending.length); w++) workers.push(worker());
        await Promise.all(workers);
    } finally {
        _livePollBusy = false;
    }
    persist();
    if (activeModalBotId === b.id) renderChannelsList(b);
}

function startChannelsLiveMonitor(b) {
    stopChannelsLiveMonitor();
    if (!b) return;
    pollChannelsLiveStatus(b);
    channelsLiveMonitorTimer = setInterval(function() {
        var bb = findBot(activeModalBotId);
        if (bb) pollChannelsLiveStatus(bb);
        else stopChannelsLiveMonitor();
    }, 30000);
}

function stopChannelsLiveMonitor() {
    if (channelsLiveMonitorTimer) {
        clearInterval(channelsLiveMonitorTimer);
        channelsLiveMonitorTimer = null;
    }
}

async function tryFetchWithAllProxies(kickPath, options) {
    options = options || {};
    var timeout = options.timeout || 8000;
    var fullUrl = KICK_BASE + kickPath;
    var preferred = (typeof options.preferredProxy === 'number') ? options.preferredProxy : _bestProxy;

    var out = await smartFetch(fullUrl, {
        method: 'GET',
        headers: { 'Accept':'application/json' },
        credentials: isDirectMode ? 'include' : 'omit',
        timeout: timeout
    }, preferred);
    if (out && out.res) {
        if (out.res.ok) { _proxyFailCount[out.proxyUsed] = 0; return { res: out.res, proxyUsed: out.proxyUsed, ok: true }; }
        if (out.res.status === 404) { return { ok: false, notFound: true }; }
        return { ok: false, notFound: false, res: out.res, proxyUsed: out.proxyUsed };
    }
    return { ok: false, notFound: false };
}

async function resolveChatroomAllVariants(slug, bot) {
    var variants = [slug];
    if (slug.indexOf('_') !== -1) variants.push(slug.replace(/_/g, '-'));
    if (slug.indexOf('-') !== -1) variants.push(slug.replace(/-/g, '_'));
    var seen = {}, list = [];
    variants.forEach(function(v){ if (!seen[v]) { seen[v] = 1; list.push(v); } });
    var notFoundCount = 0;
    for (var i = 0; i < list.length; i++) {
        try {
            var v1 = await verifyChannelComprehensive(list[i], bot);
            if (v1.ok && v1.chatroomId) return { id: v1.chatroomId, notFound: false };
            if (v1.reason === 'not_found') notFoundCount++;
        } catch (e) {}
        try {
            var cd = await fetchChannel(list[i], bot);
            var c1 = extractChatroomId(cd);
            if (c1) return { id: c1, notFound: false };
        } catch (e) { if (e && e.message === 'NOT_FOUND') notFoundCount++; }
        try {
            var c2 = await fetchChatroomId(list[i], bot);
            if (c2) return { id: c2, notFound: false };
        } catch (e) {}
    }
    return { id: null, notFound: notFoundCount >= list.length };
}

async function verifyChannelComprehensive(slug, bot) {
    slug = slug.trim().toLowerCase().replace(/^\/+|\/+$/g, '').replace(/\s+/g, '');
    if (!slug) return { ok: false, reason: 'empty' };

    var endpoints = [
        '/api/v2/channels/' + slug,
        '/api/v1/channels/' + slug,
        '/api/v2/channels/' + slug + '/chatroom'
    ];

    for (var ei = 0; ei < endpoints.length; ei++) {
        var result = await tryFetchWithAllProxies(endpoints[ei], {
            timeout: 8000,
            preferredProxy: bot ? bot.workingProxy : undefined
        });

        if (result && result.ok) {
            try {
                var data = await result.res.json();
                if (data) {
                    var cid = extractChatroomId(data);
                    if (cid) {
                        if (bot) bot.workingProxy = result.proxyUsed;
                        return { ok: true, chatroomId: cid };
                    }
                }
            } catch(e) {}
        }
        if (result && result.notFound) {
            return { ok: false, reason: 'not_found' };
        }
    }

    var searchResult = await tryFetchWithAllProxies('/api/search?q=' + encodeURIComponent(slug), {
        timeout: 8000,
        preferredProxy: bot ? bot.workingProxy : undefined
    });

    if (searchResult && searchResult.ok) {
        try {
            var searchData = await searchResult.res.json();
            if (searchData) {
                var items = searchData.data || searchData;
                if (Array.isArray(items)) {
                    for (var i = 0; i < items.length; i++) {
                        var item = items[i];
                        if (item.slug === slug || item.username === slug) {
                            var cid2 = extractChatroomId(item);
                            if (cid2) {
                                if (bot) bot.workingProxy = searchResult.proxyUsed;
                                return { ok: true, chatroomId: cid2 };
                            }
                        }
                    }
                }
            }
        } catch(e) {}
    }

    return { ok: false, reason: 'connection_error' };
}

var _kickAppToken = null, _kickAppTokenExp = 0;

async function kickGetApiToken(forceNew) {
    var ut = null;
    try { ut = sessionStorage.getItem('kick_access_token'); } catch (e) {}
    if (ut && !forceNew) return ut;
    if (_kickAppToken && Date.now() < _kickAppTokenExp && !forceNew) return _kickAppToken;
    var body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: KICK_CLIENT_ID,
        client_secret: KICK_CLIENT_SECRET
    });
    var _tokOut = await smartFetch('https://id.kick.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body,
        timeout: 10000
    }, _bestProxy);
    var r = _tokOut && _tokOut.res;
    if (!r) throw new Error('token_failed');
    var d = await r.json().catch(function(){ return {}; });
    if (!r.ok || !d.access_token) throw new Error('token_failed');
    _kickAppToken = d.access_token;
    _kickAppTokenExp = Date.now() + Math.max(60, (d.expires_in || 3600) - 120) * 1000;
    return _kickAppToken;
}

function _slugLoose(s) { return String(s || '').toLowerCase().replace(/[\s\-_]/g, ''); }

async function kickVerifyChannelApi(typed) {
    var variants = [typed];
    if (typed.indexOf('_') !== -1) variants.push(typed.replace(/_/g, '-'));
    if (typed.indexOf('-') !== -1) variants.push(typed.replace(/-/g, '_'));
    var sawError = false;

    for (var vi = 0; vi < variants.length; vi++) {
        for (var attempt = 0; attempt < 2; attempt++) {
            try {
                var token = await kickGetApiToken(attempt === 1);
                var _vc = await smartFetch('https://api.kick.com/public/v1/channels?slug=' + encodeURIComponent(variants[vi]), {
                    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
                    timeout: 10000
                }, _bestProxy);
                var r = _vc && _vc.res;
                if (!r) { sawError = true; break; }
                if (r.status === 401 && attempt === 0) { _kickAppToken = null; try { sessionStorage.removeItem('kick_access_token'); } catch (e) {} continue; }
                if (!r.ok && r.status !== 404) { sawError = true; break; }
                var d = await r.json().catch(function(){ return null; });
                var list = d && d.data;
                if (list && !Array.isArray(list)) list = [list];
                if (list && list.length) {
                    var pick = null;
                    for (var i = 0; i < list.length; i++) {
                        if (_slugLoose(list[i].slug) === _slugLoose(typed)) { pick = list[i]; break; }
                    }
                    if (!pick) pick = list[0];
                    if (pick && pick.slug) {
                        return {
                            ok: true,
                            slug: String(pick.slug).trim().toLowerCase(),
                            broadcasterId: pick.broadcaster_user_id || null,
                            isLive: !!(pick.stream && pick.stream.is_live)
                        };
                    }
                }
                break;
            } catch (e) {
                sawError = true;
                break;
            }
        }
    }
    return { ok: false, reason: sawError ? 'error' : 'not_found' };
}

var MAX_SEND_RETRIES = 8;
var RETRY_DELAY = 800;

function randomInt(min, max) {
    min = Math.max(1, Math.floor(min));
    max = Math.max(min, Math.floor(max));
    var range = max - min + 1;
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        try {
            var arr = new Uint32Array(1);
            crypto.getRandomValues(arr);
            return min + (arr[0] % range);
        } catch(e) {}
    }
    return min + Math.floor(Math.random() * range);
}

function delay(ms, signal) {
    return new Promise(function(resolve, reject) {
        if (signal && signal.aborted) { reject(new Error('aborted')); return; }
        var t = setTimeout(resolve, ms);
        if (signal) signal.addEventListener('abort', function() {
            clearTimeout(t);
            reject(new Error('aborted'));
        }, {once: true});
    });
}

async function startBotLoop(bot) {
    if (_forceStopAll) return;
    var bUnified = getBotUnified(bot);
    var unifiedReady = bUnified.enabled && bUnified.messages && bUnified.messages.trim();
    var validChannels = bot.channels.filter(function(c){
        if (c.enabled === false) return false;
        if (unifiedReady) return true;
        return c.messages && c.messages.trim();
    });
    if (validChannels.length === 0) return;

    bot.isSending = true;
    bot.sent = 0;
    for (var i = 0; i < bot.channels.length; i++) {
        if (bot.channels[i].enabled !== false) {
            bot.channels[i].status = 'idle';
        }
        bot.channels[i].sent = 0;
        bot.channels[i].error = '';
        bot.channels[i].retries = 0;
    }
    abortControllers[bot.id] = new AbortController();
    forceUIUpdate();
    var _bgPoll = setInterval(function() {
        if (bot.isSending) { try { pollChannelsLiveStatus(bot); } catch (e) {} }
    }, 30000);

    if (bot.parallel === false && validChannels.length > 1) {
        for (var s = 0; s < validChannels.length; s++) {
            if (!bot.isSending || _forceStopAll) break;
            if (validChannels[s].enabled === false) continue;
            try { await runChannelLoop(bot, validChannels[s]); } catch(e) {}
        }
    } else {
        var loops = [];
        for (var j = 0; j < validChannels.length; j++) {
            loops.push(runChannelLoop(bot, validChannels[j]));
        }
        await Promise.allSettled(loops);
    }

    clearInterval(_bgPoll);
    bot.isSending = false;
    delete abortControllers[bot.id];
    forceUIUpdate();
}

async function runChannelLoop(bot, ch) {
    var slug = ch.slug;
    if (ch.enabled === false) {
        ch.status = 'idle';
        return;
    }
    var eff = getEffectiveChannelSettings(ch, bot);
    var msgs = eff.messages.split('\n').map(function(l){ return l.trim(); }).filter(Boolean);
    var infinite = eff.isInfinite;
    var repeatCount = infinite ? 999999 : Math.max(1, eff.repeat || 1);
    var interval = eff.interval || 5;

    while (bot.isSending) {
        if (ch.enabled === false) {
            ch.status = 'idle';
            ch.error = '';
            requestUIUpdate();
            return;
        }
        try {
            await runChannelOnce(bot, ch, eff, msgs, interval, infinite, repeatCount);
            break;
        } catch(e) {
            if (!bot.isSending) break;
            if (ch.enabled === false) {
                ch.status = 'idle';
                requestUIUpdate();
                return;
            }
            if (!infinite) {
                var msg = e.message;
                if (e instanceof TypeError || msg.indexOf('Failed to fetch')>=0 || msg==='timeout') msg='خطأ اتصال';
                ch.status = 'off';
                ch.error = msg;
                toast('('+bot.username+' → '+slug+') '+msg, 'e');
                requestUIUpdate();
                break;
            }
            ch.retries++;
            var emsg = e.message;
            if (e instanceof TypeError || emsg.indexOf('Failed to fetch')>=0 || emsg==='timeout') emsg='خطأ اتصال';
            ch.status = 'warning';
            ch.error = 'إعادة #'+ch.retries+': '+emsg;
            requestUIUpdate();
            var waitMs = NetworkGuard.isOnline ? 5000 : 3000;
            try { await delay(waitMs, abortControllers[bot.id] ? abortControllers[bot.id].signal : undefined); }
            catch(aborted) { bot.isSending = false; break; }
        }
    }

    if (!bot.isSending && ch.status !== 'off' && ch.enabled !== false) ch.status = 'on';
    requestUIUpdate();
}

async function runChannelOnce(bot, ch, eff, msgs, interval, infinite, repeatCount) {
    var slug = ch.slug;
    var cid = null;
    var fa = 0;
    if (ch.enabled === false) {
        ch.status = 'idle';
        return;
    }
    if (ch.chatroomId && ch.verified) {
        cid = ch.chatroomId;
        ch.status = 'on';
        ch.error = '';
        requestUIUpdate();
    } else {
        ch.status = 'connecting';
        requestUIUpdate();
        while (!cid && bot.isSending) {
            if (ch.enabled === false) {
                ch.status = 'idle';
                requestUIUpdate();
                return;
            }
            if (!NetworkGuard.isOnline && infinite) {
                ch.status = 'warning';
                ch.error = 'بانتظار عودة الإنترنت...';
                requestUIUpdate();
                try { await delay(2000, abortControllers[bot.id] ? abortControllers[bot.id].signal : undefined); }
                catch(aborted) { return; }
                continue;
            }
            try {
                var ckey = slug.replace(/_/g, '-');
                cid = _chatroomCache[ckey] || null;
                if (!cid) {
                    var rr = await resolveChatroomAllVariants(slug, bot);
                    if (rr.id) {
                        cid = rr.id;
                    } else if (rr.notFound) {
                        ch.status = 'off';
                        ch.error = 'القناة غير موجودة — تحقق من الاسم';
                        requestUIUpdate();
                        return;
                    } else {
                        throw new Error('تعذر جلب غرفة الشات');
                    }
                    if (cid) _chatroomCache[ckey] = cid;
                }
                if (cid) {
                    ch.chatroomId = cid;
                    ch.verified = true;
                    persist();
                }
            } catch(e) {
                fa++;
                if (!infinite && fa >= 2) throw e;
                if (infinite) {
                    if (fa === 1) { try { await refreshXsrf(); } catch(refE) {} }
                    ch.status = 'warning';
                    ch.error = NetworkGuard.isOnline ? ('إعادة جلب ('+fa+')') : 'بانتظار الإنترنت...';
                    requestUIUpdate();
                    var wait = NetworkGuard.isOnline ? Math.min(3000 + fa * 1500, 20000) : 3000;
                    try { await delay(wait, abortControllers[bot.id] ? abortControllers[bot.id].signal : undefined); }
                    catch(aborted) { return; }
                }
            }
        }
        if (!cid) return;
        ch.status = 'on';
        ch.error = '';
        requestUIUpdate();
    }

    var msgPool = [];
    var lastSentMsg = null;
    var msgIndex = 0;
    function nextMessage() {
        if (!eff.randomMessages) {
            var msg = msgs[msgIndex % msgs.length];
            msgIndex++;
            return msg;
        }
        if (msgPool.length === 0) {
            msgPool = msgs.slice();
            if (lastSentMsg !== null && msgPool.length > 1) {
                var idx = msgPool.indexOf(lastSentMsg);
                if (idx >= 0) {
                    msgPool.splice(idx, 1);
                    var randPos = Math.floor(Math.random() * (msgPool.length + 1));
                    msgPool.splice(randPos, 0, lastSentMsg);
                }
            }
        }
        var pickIdx = Math.floor(Math.random() * msgPool.length);
        var picked = msgPool.splice(pickIdx, 1)[0];
        lastSentMsg = picked;
        return picked;
    }

    function getDelay() {
        if (eff.randomDelay) {
            return randomInt(eff.delayMin || 3, eff.delayMax || 7);
        }
        return interval;
    }

    var roundNum = 0;
    var sentInRound = 0;
    var lastLiveCheck = 0;
    var offlineStreak = 0;
    var sig = function() { return abortControllers[bot.id] ? abortControllers[bot.id].signal : undefined; };

    var unknownStreak = 0;
    async function checkLiveNow() {
        if (eff.exempt || isExemptChannel(slug)) return true;
        if (eff.sendToNonLive) return true;
        var now = Date.now();
        if (now - lastLiveCheck < 10000 && (ch.isLive === true || ch.isLive === false)) {
            return ch.isLive;
        }
        lastLiveCheck = now;
        var live = await checkChannelLive(slug, bot);
        if (live === false && ch.isLive === true) {
            try { await delay(1500, sig()); } catch(aborted) { return false; }
            var again = await checkChannelLive(slug, bot);
            if (again === true) live = true;
        }
        if (live === null) {
            unknownStreak++;
            if (ch.isLive === true && unknownStreak < 6) return true;
            if (ch.isLive !== false) return true;
            live = false;
        } else {
            unknownStreak = 0;
        }
        var wasLive = ch.isLive;
        ch.isLive = live;
        if (wasLive === true && live === false) {
            ch.status = 'warning';
            ch.error = 'توقف البث — بانتظار عودته...';
            requestUIUpdate();
        } else if (wasLive !== true && live === true) {
            ch.status = 'on';
            ch.error = '';
            requestUIUpdate();
        }
        return live;
    }

    async function waitForLive() {
        ch.status = 'warning';
        ch.error = 'القناة أوفلاين — بانتظار بدء البث...';
        requestUIUpdate();
        while (bot.isSending) {
            if (ch.enabled === false) { ch.status = 'idle'; requestUIUpdate(); return false; }
            try { await delay(10000, sig()); } catch(aborted) { return false; }
            var live = (ch.isLive === true) ? true : await checkChannelLive(slug, bot);
            if (live === null && ch.isLive === true) live = true;
            if (live === true) {
                ch.isLive = true;
                ch.status = 'on';
                ch.error = '';
                lastLiveCheck = Date.now();
                requestUIUpdate();
                return true;
            }
        }
        return false;
    }

    if (!eff.sendToNonLive) {
        var isLive = await checkLiveNow();
        if (!isLive) {
            var resumed = await waitForLive();
            if (!resumed) return;
        }
    }

    while (bot.isSending) {
        if (ch.enabled === false) {
            ch.status = 'idle';
            requestUIUpdate();
            return;
        }
        if (!infinite && roundNum >= repeatCount) break;

        if (!eff.sendToNonLive) {
            var liveNow = await checkLiveNow();
            if (!liveNow) {
                var resumed = await waitForLive();
                if (!resumed) return;
            }
        }

        if (sentInRound >= msgs.length) {
            sentInRound = 0;
            roundNum++;
            if (!infinite && roundNum >= repeatCount) break;
            if (eff.randomMessages) {
                msgPool = [];
            }
        }

        if (!bot.isSending) break;

        async function sendOneMessage() {
            var currentMsg = nextMessage();
            sentInRound++;

            if (ch.enabled === false) {
                ch.status = 'idle';
                requestUIUpdate();
                return 'exit';
            }

            if (!eff.sendToNonLive) {
                var stillLive = await checkLiveNow();
                if (!stillLive) {
                    var resumed2 = await waitForLive();
                    if (!resumed2) return 'exit';
                }
            }

            if (!NetworkGuard.isOnline && infinite) {
                ch.status = 'warning';
                ch.error = 'بانتظار عودة الإنترنت...';
                requestUIUpdate();
                while (!NetworkGuard.isOnline && bot.isSending) {
                    if (ch.enabled === false) {
                        ch.status = 'idle';
                        requestUIUpdate();
                        return 'exit';
                    }
                    try { await delay(1000, abortControllers[bot.id] ? abortControllers[bot.id].signal : undefined); }
                    catch(aborted) { return 'exit'; }
                }
                if (!bot.isSending) return 'exit';
                ch.status = 'on';
            }

            var msgSentLocal = false, failCount = 0, lastErr = null, rateHits = 0;
            while (!msgSentLocal && bot.isSending) {
                if (!infinite && failCount >= MAX_SEND_RETRIES) break;
                if (rateHits >= 30) break;
                try {
                    var result = await sendMessage(cid, currentMsg, bot.token, bot.workingSendProxy);
                    if (result.proxyUsed >= 0) bot.workingSendProxy = result.proxyUsed;
                    bot.sent++;
                    ch.sent++;
                    msgSentLocal = true;
                    ch.status = 'on';
                    ch.error = '';
                    requestUIUpdate();
                } catch(e) {
                    var isRate = (e && e.status === 429) || (e && e.message && e.message.indexOf('حد السرعة')>=0);
                    if (isRate) { rateHits++; } else { failCount++; }
                    lastErr = e;
                    var isCritical = !isRate && (e.message.indexOf('حظر')>=0 || e.message.indexOf('صلاحية')>=0 || e.message.indexOf('منتهي')>=0);
                    var isNetwork = (e instanceof TypeError) || e.message.indexOf('Failed to fetch')>=0 || e.message==='timeout';

                    if (isCritical && !infinite) throw e;

                    if (bot.isSending) {
                        var backoff;
                        if (isNetwork && !NetworkGuard.isOnline) {
                            ch.status = 'warning';
                            ch.error = 'بانتظار عودة الإنترنت...';
                            requestUIUpdate();
                            while (!NetworkGuard.isOnline && bot.isSending) {
                                if (ch.enabled === false) {
                                    ch.status = 'idle';
                                    requestUIUpdate();
                                    return 'exit';
                                }
                                try { await delay(1000, abortControllers[bot.id] ? abortControllers[bot.id].signal : undefined); }
                                catch(aborted) { return 'exit'; }
                            }
                            if (!bot.isSending) return 'exit';
                            continue;
                        } else if (isRate) {
                            backoff = Math.min(Math.max(((e.retryAfter || 0) * 1000), 3000 + rateHits * 1000), 30000);
                        } else if (isCritical) {
                            backoff = Math.min(5000 + (failCount * 1500), 30000);
                            if (failCount === 1) toast('('+bot.username+' → '+slug+') '+e.message+' — إعادة خلال '+Math.round(backoff/1000)+'ث', 'i');
                        } else if (isNetwork) {
                            backoff = 1000 + Math.min(failCount * 500, 4000);
                        } else {
                            backoff = RETRY_DELAY + Math.min(failCount * 200, 2000);
                        }
                        ch.status = 'warning';
                        ch.error = isRate ? ('حد السرعة — انتظار ('+rateHits+')') : isCritical ? (e.message+' ('+failCount+')') :
                                      isNetwork ? ('إعادة اتصال ('+failCount+')') :
                                      ('إعادة ('+failCount+')');
                        requestUIUpdate();
                        try { await delay(backoff, abortControllers[bot.id] ? abortControllers[bot.id].signal : undefined); }
                        catch(aborted) { return 'exit'; }
                    }
                }
            }
            return msgSentLocal ? 'sent' : 'failed';
        }

        var _iterStart = Date.now();
        var r1 = await sendOneMessage();
        if (r1 === 'exit') return;
        var msgSent = (r1 === 'sent');

        if (eff.fourMessages && msgSent && bot.isSending && ch.enabled !== false) {
            for (var fm = 0; fm < 3; fm++) {
                if (!bot.isSending || ch.enabled === false) break;
                try { await delay(7500, abortControllers[bot.id] ? abortControllers[bot.id].signal : undefined); }
                catch(aborted) { return; }
                if (bot.isSending && ch.enabled !== false) {
                    var rfm = await sendOneMessage();
                    if (rfm === 'exit') return;
                }
            }
        }
        else if (eff.twoMessages && msgSent && bot.isSending && ch.enabled !== false) {
            try { await delay(40, abortControllers[bot.id] ? abortControllers[bot.id].signal : undefined); }
            catch(aborted) { return; }
            if (bot.isSending && ch.enabled !== false) {
                var r2 = await sendOneMessage();
                if (r2 === 'exit') return;
            }
        }

        if (bot.isSending) {
            var isLastInRound = (sentInRound >= msgs.length);
            var isLastRound = (!infinite && roundNum >= repeatCount - 1);
            if (!(isLastInRound && isLastRound)) {
                var waitSec = getDelay();
                var totalWaitMs = Math.max(250, waitSec * 1000 - (Date.now() - _iterStart));
                var chunkMs = 30000;
                var waitedMs = 0;
                while (waitedMs < totalWaitMs && bot.isSending) {
                    var remainingMs = totalWaitMs - waitedMs;
                    var sleepMs = Math.min(chunkMs, remainingMs);
                    try { await delay(sleepMs, abortControllers[bot.id] ? abortControllers[bot.id].signal : undefined); }
                    catch(aborted) { return; }
                    waitedMs += sleepMs;
                    if (!eff.sendToNonLive && bot.isSending && waitedMs < totalWaitMs) {
                        var liveCheck = await checkLiveNow();
                        if (!liveCheck) {
                            var resumed3 = await waitForLive();
                            if (!resumed3) return;
                        }
                    }
                }
            }
        }
    }
}

var _TC_REQ_TIMEOUT        = 7000;
var _TC_TOKEN_BUDGET       = 22000;
var _TC_CONCURRENCY        = 6;
var _TC_RETRY_CONCURRENCY  = 3;
var _tcRunning             = false;

var _TC_PROXIES = [
  { name:'direct', build:function(u){ return u; } }
];

for (var _kbPx = 0; _kbPx < KB_PROXIES.length; _kbPx++) {
  (function(px){ _TC_PROXIES.push({ name: px.name, build: px.build }); })(KB_PROXIES[_kbPx]);
}

async function _tcGet(url, token, timeout){
  var headers = { 'Accept':'application/json', 'Origin':KICK_BASE };
  if (token){ headers['Authorization'] = 'Bearer ' + token; }
  if (typeof xsrfToken !== 'undefined' && xsrfToken){ headers['X-XSRF-TOKEN'] = xsrfToken; }
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var timer = setTimeout(function(){ if (ctrl){ try { ctrl.abort(); } catch(e){} } }, timeout);
  try {
    var opts = { method:'GET', headers:headers, credentials:(typeof isDirectMode !== 'undefined' && isDirectMode) ? 'include' : 'omit' };
    if (ctrl) opts.signal = ctrl.signal;
    var _tcRes = await fetch(url, opts);

    try {
      if (_tcRes && typeof _kbIsProxyOwnError === 'function') {
        var _tcSample = '';
        if (typeof _tcRes.clone === 'function') { _tcSample = String(await _tcRes.clone().text() || '').slice(0, 400); }
        if ((_tcRes.status === 401 || _tcRes.status === 403 || _tcRes.status === 429) && _kbIsProxyOwnError(_tcRes, _tcSample)) {
          return _mkRes('{"proxy_error":true}', 502);
        }
      }
    } catch(e){}
    return _tcRes;
  } finally { clearTimeout(timer); }
}

async function _tcRunLimited(items, limit, worker){
  var results = new Array(items.length);
  var idx = 0;
  async function runner(){
    while (idx < items.length){
      var i = idx++;
      try { results[i] = await worker(items[i], i); }
      catch(e){ results[i] = { status:'unknown', error:String((e && e.message) || e) }; }
    }
  }
  var n = Math.max(1, Math.min(limit, items.length));
  var pool = [];
  for (var k = 0; k < n; k++){ pool.push(runner()); }
  await Promise.all(pool);
  return results;
}

async function _tcCheckLegacy(bot){
  var tok = String((bot && bot.token) || '').trim();
  var fb  = (bot && bot.username) || 'حساب';
  if (!tok){ return { status:'expired', username:fb, reason:'لا يوجد توكن' }; }
  if (/^bearer\s+/i.test(tok)){ tok = tok.replace(/^bearer\s+/i, '').trim(); }

  var endpoints = ['/api/v1/user', '/api/v2/user'];
  var list = _TC_PROXIES.slice();

  var deadline = Date.now() + _TC_TOKEN_BUDGET;
  var authFail = false, noUserEvidence = false, anyResponse = false, lastErr = '';

  for (var ei = 0; ei < endpoints.length; ei++){
    for (var pi = 0; pi < list.length; pi++){
      if (Date.now() > deadline){ break; }
      var px = list[pi], url;
      try { url = px.build(KICK_BASE + endpoints[ei] + '?_=' + Date.now() + '_' + Math.random().toString(36).slice(2)); }
      catch(e){ continue; }
      var res = null;
      try { res = await _tcGet(url, tok, _TC_REQ_TIMEOUT); }
      catch(e){ lastErr = String((e && e.message) || e); continue; }
      anyResponse = true;
      var st = res.status;

      if (st === 401 || st === 403){
        var _isTrusted = true;
        var _b = '';
        try { _b = String(await res.text() || '').trim(); } catch(e){}
        var _looksJson = (_b.charAt(0) === '{' || _b.charAt(0) === '[');
        if (_isTrusted && _looksJson){ authFail = true; } else { lastErr = 'HTTP ' + st + ' (proxy)'; }
        continue;
      }
      if (st === 404 || st === 502 || st === 503 || st === 520 || st === 522 || st === 524){ lastErr = 'HTTP ' + st; continue; }
      if (!res.ok){ lastErr = 'HTTP ' + st; continue; }

      var raw = '';
      try { raw = await res.text(); } catch(e){ lastErr = 'read-fail'; continue; }
      var txt = String(raw || '').trim();
      if (!txt){ lastErr = 'empty-body'; continue; }

      if (/unauthenticated|unauthorized|invalid[_ ]?token|token[_ ]?expired|token has expired|"token"\s*:\s*\[\s*\]/i.test(txt)){
        authFail = true;
        continue;
      }

      var data = null;
      try { data = JSON.parse(txt); } catch(e){ lastErr = 'bad-json'; continue; }
      if (data && data.errors && !data.id && !data.username){ lastErr = 'errors'; continue; }

      var src = data;
      if (data && typeof data === 'object'){
        if (data.user && typeof data.user === 'object'){ src = data.user; }
        else if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)){ src = data.data; }
      }
      var uname = src && (src.username || src.slug || src.name);
      if (uname){ return { status:'active', username:String(uname), proxy:px.name }; }

      noUserEvidence = true;
    }
    if (Date.now() > deadline){ break; }
  }

  if (authFail){
    return { status:'expired', username:fb, reason:'رفض مصادقة (401/403)' };
  }
  return { status:'unknown', username:fb, error: lastErr || 'فشل الاتصال — تحقق من الإنترنت' };
}

async function checkSingleTokenStatus(bot){
  var tok = String((bot && bot.token) || '').trim();
  var fb  = (bot && bot.username) || 'حساب';
  if (!tok){ return { status:'expired', username:fb, reason:'لا يوجد توكن' }; }
  if (/^bearer\s+/i.test(tok)){ tok = tok.replace(/^bearer\s+/i, '').trim(); }

  if (typeof proxiedFetch === 'function'){
    var pr = null;
    var endpoints = ['/api/v1/user', '/api/v2/user'];
    for (var ei = 0; ei < endpoints.length && (!pr || !pr.res.ok); ei++){
      try { pr = await proxiedFetch(endpoints[ei], { token:tok, timeout:6000 }); } catch(e){ continue; }
    }
    if (pr && pr.res){
      if (!pr.res.ok){
        if (pr.res.status === 401 || pr.res.status === 403){
          return { status:'expired', username:fb, reason:'التوكن منتهي' };
        }
      } else {
        try {
          var data = JSON.parse(await pr.res.text());
          var uname = data && (data.username || (data.user && data.user.username) || (data.data && data.data.username) || data.slug || data.name);
          if (uname){ return { status:'active', username:String(uname) }; }
          if (data && data.id){ return { status:'active', username:fb }; }
        } catch(e){}
      }
    }
  }
  return _tcCheckLegacy(bot);
}

function _tcRender(results, list, elapsedMs){
  var content = $('tokenCheckContent');
  if (!content){ return; }
  var expired = [], active = [], unknown = [];
  for (var i = 0; i < list.length; i++){
    var b = list[i] || {};
    var r = results[i] || { status:'unknown' };
    var name = (b.username || (r && r.username) || ('حساب #' + (i + 1)));
    if (r && r.status === 'active'){ active.push(r.username || name); }
    else if (r && r.status === 'expired'){ expired.push(name); }
    else { unknown.push(name); }
  }
  var h = '';
  h += '<div class="token-check-stats">';
  h += '<div class="token-stat expired"><div class="ts-icon"><i class="fas fa-triangle-exclamation"></i></div><div class="ts-num">' + expired.length + '</div><div class="ts-label">توكن منتهي</div></div>';
  h += '<div class="token-stat active"><div class="ts-icon"><i class="fas fa-circle-check"></i></div><div class="ts-num">' + active.length + '</div><div class="ts-label">توكن يعمل</div></div>';
  h += '</div>';

  h += '<div class="token-check-section-title"><i class="fas fa-user-xmark"></i><span>الحسابات التي انتهت توكناتها</span></div>';
  if (expired.length){
    h += '<div class="expired-list">';
    for (var e = 0; e < expired.length; e++){
      h += '<div class="expired-account"><i class="fas fa-circle-xmark"></i><span>' + escH(expired[e]) + '</span></div>';
    }
    h += '</div>';
  } else {
    h += '<div class="token-empty"><i class="fas fa-shield-check"></i><br>لا يوجد أي حساب بتوكن منتهي.</div>';
  }

  if (active.length){
    h += '<div class="token-check-section-title"><i class="fas fa-user-check"></i><span>الحسابات التي تعمل توكناتها</span></div>';
    h += '<div class="expired-list" style="max-height:150px">';
    for (var a = 0; a < active.length; a++){
      h += '<div class="expired-account" style="background:rgba(0,200,83,.06);border-color:rgba(0,200,83,.18);color:#c9ffdd"><i class="fas fa-circle-check" style="color:#59ef96"></i><span>' + escH(active[a]) + '</span></div>';
    }
    h += '</div>';
  }

  if (unknown.length){
    h += '<div class="token-check-section-title"><i class="fas fa-circle-question"></i><span>حسابات تعذّر التحقق منها</span></div>';
    h += '<div class="expired-list" style="max-height:150px">';
    for (var u = 0; u < unknown.length; u++){
      h += '<div class="expired-account" style="background:rgba(255,193,7,.06);border-color:rgba(255,193,7,.22);color:#ffe6a3"><i class="fas fa-circle-question" style="color:#ffd966"></i><span>' + escH(unknown[u]) + '</span></div>';
    }
    h += '</div>';
    h += '<div class="token-check-errors"><i class="fas fa-triangle-exclamation"></i> تعذّر التحقق من ' + unknown.length + ' حساب بعد إعادة المحاولة، لذلك لم تُحسب ضمن التوكنات العاملة أو المنتهية. جرّب الضغط على الفحص مرة أخرى.</div>';
  }

  var secs = (Math.round(elapsedMs / 100) / 10);
  h += '<div class="token-check-note">تم الفحص خلال ' + secs + ' ثانية • الإجمالي: ' + list.length + ' حساب — يعمل: ' + active.length + ' • منتهي: ' + expired.length + ' • غامض: ' + unknown.length + '</div>';
  content.innerHTML = h;
}

function openTokenCheck(){
  var modal = $('tokenCheckModal'), content = $('tokenCheckContent');
  if (!modal || !content){ return; }
  modal.classList.add('open');
  content.innerHTML = '<div class="token-check-loading"><div class="spinner"></div><span id="tcProg">جاري فحص الحسابات...</span></div>';
  runTokenCheck();
}
function closeTokenCheck(){ var m = $('tokenCheckModal'); if (m){ m.classList.remove('open'); } }

async function runTokenCheck(){
  var content = $('tokenCheckContent');
  if (!content){ return; }
  if (_tcRunning){ return; }

  var list = (typeof accounts !== 'undefined' && Array.isArray(accounts)) ? accounts.slice() : [];
  if (!list.length){
    content.innerHTML = '<div class="token-empty"><i class="fas fa-circle-info"></i><br>لا توجد حسابات في القائمة لفحصها.</div>';
    return;
  }

  _tcRunning = true;
  var started = Date.now();
  var total = list.length;
  var done = 0;
  var results = new Array(total);

  function paint(prefix){
    var el = $('tcProg');
    if (el){ el.textContent = (prefix || 'جاري فحص') + ' ' + done + ' / ' + total + ' ...'; }
  }

  content.innerHTML = '<div class="token-check-loading"><div class="spinner"></div><span id="tcProg">جاري فحص 0 / ' + total + ' ...</span></div>';

  try {
    await _tcRunLimited(list, _TC_CONCURRENCY, async function(bot, i){
      var r;
      try { r = await checkSingleTokenStatus(bot); }
      catch(e){ r = { status:'unknown', error:String((e && e.message) || e) }; }
      results[i] = r;
      done++;
      paint('جاري فحص');
    });

    var pending = [];
    for (var i = 0; i < total; i++){
      if (!results[i] || results[i].status === 'unknown'){ pending.push(i); }
    }
    if (pending.length){
      done = total - pending.length;
      paint('إعادة محاولة الفحص');
      await _tcRunLimited(pending, _TC_RETRY_CONCURRENCY, async function(idx){
        var r2;
        try { r2 = await checkSingleTokenStatus(list[idx]); }
        catch(e){ r2 = { status:'unknown', error:String((e && e.message) || e) }; }
        if (r2 && r2.status && r2.status !== 'unknown'){ results[idx] = r2; }
        done++;
        paint('إعادة محاولة الفحص');
      });
    }
  } catch(err){
    _tcRunning = false;
    var ok = 0;
    for (var q = 0; q < total; q++){ if (results[q]){ ok++; } }
    if (ok){ _tcRender(results, list, Date.now() - started); }
    else { content.innerHTML = '<div class="token-check-errors"><i class="fas fa-triangle-exclamation"></i> حدث خطأ أثناء الفحص: ' + escH(String((err && err.message) || err)) + '<br>حاول مرة أخرى.</div>'; }
    return;
  }

  _tcRunning = false;
  _tcRender(results, list, Date.now() - started);
}
