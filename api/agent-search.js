// api/agent-search.js — Cerveau: Groq · Photos: Gemini · Recherche: DuckDuckGo 2 passes · Prix: eBay vendus + LULU-BERLU
const SYSTEM_PROMPT = `Tu es Action Archive-Bot, un expert mondial en jouets vintage, figurines de collection et rétrogaming des années 1970 à 2000. Ton but : aider l'utilisateur à identifier des jouets, estimer leur rareté, leur état (Loose, MIB, NRFB) et leur valeur historique.

RÈGLES (primordiales) :
- Ne suppose JAMAIS reproduction/original (impossible par photo). Estime par défaut le MARCHÉ DE L'ORIGINAL, mention "(sous réserve d'une pièce originale)".
- HIÉRARCHIE DES SOURCES DE PRIX : 1) VENTES SPÉCIALISÉES (Lulu-Berlu = adjugé réel) — ta référence N°1 pour MIB/NRFB, cite-les explicitement ; 2) ventes soldées eBay ; 3) extraits/annonces. N'invente JAMAIS de nom d'outil interne.
- Marchés SÉPARÉS : (a) reproduction neuve, (b) original Loose, (c) original MIB/NRFB — en boîte/carte complète, souvent 3 à 10 fois le Loose.
- MIB/NRFB : ancre-toi sur les VENTES SPÉCIALISÉES puis le haut des relevés (75e centile → max). ÉTIQUETTES : "(ventes exceptionnelles au-dessus)" pour MIB/NRFB ; "(marché courant)" pour Loose.
- Devise : convertis £/$ en € (1 £ ≈ 1,17 € ; 1 $ ≈ 0,92 €).
- Ligne REPRODUCTION : UNIQUEMENT depuis le CATALOGUE ACTION ARCHIVE fourni : pièce équivalente → prix boutique EXACT + "fiche produit" ; absent → "non proposée au catalogue". Jamais de prix de reproduction inventé. Contradiction de marque → pas de lien.
- Interdits : phrases génériques, rappels d'astuces, outils fictifs.

STYLE : français, passionné, 4 blocs, 16 lignes max : IDENTIFICATION · PRIX OBSERVÉS (avec provenance + alerte si peu de relevés) · ESTIMATION (Reproduction / Loose / MIB-NRFB étiquetées) · CONSEIL (UNE ligne).
"Sources utilisées : ..." UNIQUEMENT si des sources ont servi ; sinon rien.`;

const PREF_TEXT = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-70b-versatile'];

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash'];

let modelsCache = null, textPick = null, catCache = null, luluCache = null;
const ddgCache = new Map(), priceCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;
const BUDGET_MS = 8000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function getGroqModels() {
    if (modelsCache && Date.now() - modelsCache.t < 10 * 60 * 1000) return modelsCache.ids;
    const res = await fetch(GROQ_BASE + '/models', { headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY } });
    if (!res.ok) {
        if (res.status === 401) throw new Error('Clé IA INVALIDE — vérifie GROQ_API_KEY dans Vercel');
        throw new Error('Cerveau IA momentanément indisponible (HTTP ' + res.status + ')');
    }
    const data = await res.json();
    const ids = (data.data || []).map(x => x.id);
    if (!ids.length) throw new Error('La clé IA n\'expose aucun modèle');
    modelsCache = { t: Date.now(), ids };
    return ids;
}

async function pickTextModel() {
    if (textPick) return textPick;
    const ids = await getGroqModels();
    textPick = (PREF_TEXT.find(p => ids.includes(p)) || ids.find(i => /llama|instant|versatile|instruct/i.test(i)) || ids[0]) || null;
    return textPick;
}

async function chatOrNull(model, messages, maxTokens) {
    const res = await fetch(GROQ_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0.55, max_tokens: maxTokens, messages })
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (content && content.trim()) return content;
    const raw = (data.error && data.error.message) || (JSON.stringify(data) || '').slice(0, 300);
    console.error('brain: HTTP ' + res.status + ' (modèle ' + model + ') — ' + raw);
    if ((data.error && data.error.code === 'model_not_found') || /model/i.test(raw)) { textPick = null; throw new Error('MODEL_MISSING'); }
    return null;
}

async function chat(model, messages, maxTokens, liteMessages) {
    let out = null;
    try { out = await chatOrNull(model, messages, maxTokens); } catch (e) {
        if (String(e.message) === 'MODEL_MISSING') out = null; else { try { out = await chatOrNull(model, messages, maxTokens); } catch (e2) { out = null; } }
    }
    let attempt = 0;
    while (out === null && attempt < 2) {
        attempt++;
        await new Promise(r => setTimeout(r, attempt === 1 ? 800 : 400));
        out = await chatOrNull(model, (attempt === 2 && liteMessages) ? liteMessages : messages, (attempt === 2 && liteMessages) ? maxTokens - 100 : maxTokens);
    }
    if (!out) throw new Error("Le cerveau de l'agent n'a pas répondu pour le moment (réessaie dans un instant)");
    return out;
}

// ─── Gemini vision ───
async function geminiVision(dataUrl, prompt) {
    const m = dataUrl.match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);
    if (!m) throw new Error('Image illisible');
    let lastErr = '';
    for (const model of GEMINI_MODELS) {
        try {
            const res = await fetch(GEMINI_BASE + '/' + model + ':generateContent?key=' + encodeURIComponent(process.env.GEMINI_API_KEY), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contents: [{ parts: [ { text: prompt }, { inline_data: { mime_type: m[1], data: m[2] } } ] }] })
            });
            const data = await res.json();
            const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
            const text = parts ? parts.map(p => p.text || '').join('') : '';
            if (text && text.trim()) return text.trim();
            lastErr = 'HTTP ' + res.status + ' — ' + (JSON.stringify(data) || '').slice(0, 300);
            if (res.status === 400 && /API key|invalid/i.test(lastErr)) throw new Error(lastErr);
            if (res.status === 403 || res.status === 429) throw new Error(lastErr);
        } catch (e) {
            if (String(e.message).includes('HTTP')) throw new Error(e.message);
            lastErr = e.message;
        }
    }
    throw new Error(lastErr || 'Gemini sans réponse');
}

// ─── DuckDuckGo ───
function stripTags(s) {
    return String(s || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&#x2F;/g, '/')
        .replace(/\s+/g, ' ').trim();
}
function decodeDdg(href) {
    if (!href) return '';
    href = href.startsWith('//') ? 'https:' + href : href;
    const m = href.match(/[?&]uddg=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : href;
}
async function ddgLite(q) {
    const res = await fetch('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q) + '&kl=fr-fr', {
        headers: { 'User-Agent': UA, 'Accept-Language': 'fr-fr,fr;q=0.9' }
    });
    if (!res.ok) return [];
    const html = await res.text();
    const snips = []; let m;
    const snipRe = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
    while ((m = snipRe.exec(html))) snips.push(stripTags(m[1]));
    const out = []; let i = 0;
    const linkRe = /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
    for (const match of html.matchAll(linkRe)) {
        const href = match[1];
        if (/y\.js|duckduckgo\.com\/y/.test(href)) { i++; continue; }
        const url = decodeDdg(href);
        if (!/^https?:\/\//.test(url)) { i++; continue; }
        out.push({ title: stripTags(match[2]).slice(0, 120), url, snippet: (snips[i] || '').slice(0, 220) });
        i++; if (out.length >= 6) break;
    }
    return out;
}
async function ddgHtml(q) {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
        headers: { 'User-Agent': UA, 'Accept-Language': 'fr-fr,fr;q=0.9' }
    });
    if (!res.ok) return [];
    const html = await res.text();
    const out = [];
    for (const match of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
        out.push({ title: stripTags(match[2]).slice(0, 120), url: decodeDdg(match[1]), snippet: '' });
        if (out.length >= 6) break;
    }
    const snips = [];
    for (const match of html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)) snips.push(stripTags(match[1]));
    out.forEach((r, i) => r.snippet = (snips[i] || '').slice(0, 220));
    return out;
}
async function searchDDG(query) {
    const key = query.toLowerCase().trim();
    if (!key) return [];
    const hit = ddgCache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.r;
    let results = [];
    try { results = await ddgLite(key); } catch (e) {}
    if (results.length === 0) { try { results = await ddgHtml(key); } catch (e) {} }
    ddgCache.set(key, { t: Date.now(), r: results });
    return results;
}

// ─── Pages + PRIX ───
async function fetchPageText(url, timeoutMs) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs || 2300);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'fr-fr,fr;q=0.9' } });
        if (!res.ok) return '';
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('html') && !ct.includes('text') && !ct.includes('json')) return '';
        const html = (await res.text()).slice(0, 400000);
        return html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    } catch (e) { return ''; }
    finally { clearTimeout(to); }
}

function extractPrices(text) {
    const re = /(\d{1,4}(?:[ .]\d{3})*(?:[.,]\d{1,2})?)\s*(?:€|eurs?|EUR)|(?:€|EUR)\s*(\d{1,4}(?:[ .]\d{3})*(?:[.,]\d{1,2})?)|£\s*(\d{1,4}(?:[ .]\d{3})*(?:[.,]\d{1,2})?)|(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:£|GBP)|(?:\$|USD)\s*(\d{1,4}(?:[ .]\d{3})*(?:[.,]\d{1,2})?)|(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:USD|\$)/gi;
    const found = [];
    let m;
    while ((m = re.exec(String(text || ''))) && found.length < 10) {
        const idx = [1, 2, 3, 4, 5, 6].find(i => m[i] !== undefined);
        const raw = idx !== undefined ? m[idx] : null;
        if (!raw) continue;
        const num = parseFloat(raw.replace(/[ .](?=\d{3}\b)/g, '').replace(',', '.'));
        if (isNaN(num) || num < 1 || num > 25000) continue;
        let cur = 'EUR'; if (idx === 3 || idx === 4) cur = 'GBP'; if (idx === 5 || idx === 6) cur = 'USD';
        found.push({ v: num, cur });
    }
    return found;
}
function convPush(found, src, out, cap, origLabel) {
    found.forEach(x => {
        if (out.length >= cap) return;
        const k = x.cur === 'GBP' ? 1.17 : x.cur === 'USD' ? 0.92 : 1;
        out.push({ p: Math.round(x.v * k * 100) / 100, src, orig: (x.cur === 'EUR' ? '' : ' (devise : ' + x.cur + ')') + (origLabel ? ' — ' + origLabel : '') });
    });
}

async function passFetch(query, results) {
    const kw = encodeURIComponent(query.slice(0, 110));
    const targets = [
        { url: 'https://www.ebay.fr/sch/i.html?_nkw=' + kw + '&LH_Complete=1&LH_Sold=1', src: 'eBay FR — ventes soldées' },
        { url: 'https://www.ebay.com/sch/i.html?_nkw=' + kw + '&LH_Complete=1&LH_Sold=1', src: 'eBay COM — ventes soldées (€ converti)' },
        { url: results[0] ? results[0].url : '', src: 'page web 1' },
        { url: results[1] ? results[1].url : '', src: 'page web 2' }
    ].filter(t => t.url);
    const settled = await Promise.allSettled(targets.map(t => fetchPageText(t.url, 2300)));
    const prices = [];
    let read = 0, total = targets.length;
    for (let i = 0; i < settled.length; i++) {
        if (settled[i].status !== 'fulfilled' || !settled[i].value) continue;
        read++;
        convPush(extractPrices(settled[i].value), targets[i].src, prices, 14);
    }
    prices.sort((a, b) => a.p - b.p);
    return { prices, read, total };
}

// ─── LULU-BERLU : ventes spécialisées (adjudications) — priorité MIB/NRFB ───
async function luluHarvest(query) {
    try {
        if (luluCache && Date.now() - luluCache.t < CACHE_TTL) return luluCache.data;
        const kw = query.slice(0, 80);
        // 1) Recherche ciblée sur leur site via DuckDuckGo (fiable) + 2) lecture directe de leur moteur interne
        const [siteResults, direct] = await Promise.allSettled([
            searchDDG('site:lulu-berlu.com ' + kw),
            fetchPageText('https://www.lulu-berlu.com/?s=' + encodeURIComponent(kw) + '&post_type=product', 2600)
        ]);
        let urls = [];
        if (siteResults.status === 'fulfilled') urls = siteResults.value.slice(0, 3).map(r => r.url);
        const toFetch = [];
        urls.forEach(u => { if (/lulu-berlu\.com/.test(u)) toFetch.push(u); });
        const settled2 = await Promise.allSettled(toFetch.map(u => fetchPageText(u, 2600)));
        const prices = [], listings = [];
        // extraits des résultats DDG (souvent "adjudiqué 320 €")
        if (siteResults.status === 'fulfilled') {
            siteResults.value.slice(0, 5).forEach(r => {
                convPush(extractPrices((r.title || '') + ' ' + (r.snippet || '')), 'Lulu-Berlu (extrait vente)', prices, 6, 'adjudication spécialisée');
                if (r.title) listings.push({ title: r.title.slice(0, 80), url: r.url });
            });
        }
        // pages lues : prix avec contexte (le mot-clé précédant le prix)
        for (let i = 0; i < settled2.length && prices.length < 10; i++) {
            if (settled2[i].status !== 'fulfilled' || !settled2[i].value) continue;
            const txt = settled2[i].value;
            const re = /(\d{1,4}(?:[ .]\d{3})*(?:[.,]\d{1,2})?)\s*(?:€|EUR)/g;
            let m;
            while ((m = re.exec(txt)) && prices.length < 10) {
                const before = txt.slice(Math.max(0, m.index - 140), m.index).slice(-80);
                const num = parseFloat(m[1].replace(/[ .](?=\d{3}\b)/g, '').replace(',', '.'));
                if (isNaN(num) || num < 5 || num > 25000) continue;
                prices.push({ p: Math.round(num * 100) / 100, src: 'Lulu-Berlu (page consultée) — « ' + stripTags(before) + ' »', orig: '' });
            }
        }
        const data = { prices: prices.slice(0, 10), listings: listings.slice(0, 4) };
        luluCache = { t: Date.now(), data };
        return data;
    } catch (e) { return { prices: [], listings: [] }; }
}

// ─── Passe d'affinage ───
async function refinePass(query, imgDesc, snippets) {
    try {
        const model = await pickTextModel();
        const msg = `Question utilisateur : ${query || '(photo uniquement)'}
Note visuelle (photo) : ${imgDesc || '(aucune)'}
Extraits de pages trouvées :
${snippets || '(aucun extrait)'}

Tâche : précise l'identification (marque, référence EXACTE telle qu'écrite par les collectionneurs/fabricants de l'époque, année, état) puis produis la requête optimale pour trouver des VENTES RÉELLES de CETTE pièce précise (termes anglais si plus efficaces, inclut l'état si pertinent, ex: "carded", "MIB", "sealed").
Réponds UNIQUEMENT en JSON compact : {"identification":"...","query":"..."}`;
        const out = await chat(model, [{ role: 'user', content: msg }], 320, [{ role: 'user', content: 'Extraits:\n' + (snippets || '').slice(0, 300) + '\nRends UNIQUEMENT: {"identification":"...","query":"..."}' }]);
        const t = String(out).replace(/```json|```/g, '').trim();
        const j = t.match(/\{[\s\S]*\}/) ? JSON.parse(t.match(/\{[\s\S]*\}/)[0]) : null;
        return { identification: stripTags(j && j.identification || '').slice(0, 400), query: stripTags(j && j.query || '').slice(0, 160) };
    } catch (e) { return { identification: '', query: '' }; }
}

// ─── Catalogue boutique ───
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
async function ownCatalog(host) {
    try {
        if (catCache && Date.now() - catCache.t < CACHE_TTL) return catCache.items;
        const res = await fetch('https://' + host + '/api/airtable-proxy', { headers: { 'User-Agent': 'AA-Agent/1.0' } });
        if (!res.ok) return [];
        const data = await res.json();
        const items = (Array.isArray(data) ? data : []).map(r => {
            const f = r.fields || r;
            return { id: r.id, nom: f.Nom || '', collection: f.Collection || '', prix: parseFloat(f.Prix) || 0 };
        }).filter(x => x.nom && x.prix > 0);
        catCache = { t: Date.now(), items };
        return items;
    } catch (e) { return []; }
}
const BRANDS = ['mego', 'meccano', 'palitoy', 'mattel', 'big jim', 'gi joe', 'gijoe', 'hasbro', 'ceji', 'arbois', 'popy', 'action man', 'action joe', 'kenner', 'matchbox', 'creta', 'lone star', 'gama', 'cherilea', 'britains', 'timpo', 'starlux'];
function brandGuard(item, texto) {
    const t = norm(texto);
    const mentioned = BRANDS.filter(b => t.includes(norm(b)));
    if (!mentioned.length) return true;
    const n = norm(item.nom + ' ' + item.collection);
    const present = BRANDS.filter(b => n.includes(norm(b)));
    if (!present.length) return true;
    return mentioned.some(b => present.includes(b));
}
function matchCatalogItem(items, texto) {
    const sourceText = texto.q || texto.d || '';
    const words = norm(sourceText).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3);
    if (!words.length || !items.length) return null;
    const freq = {};
    for (const it of items) {
        const n = norm(it.nom + ' ' + it.collection);
        for (const w of words) if (n.includes(w)) freq[w] = (freq[w] || 0) + 1;
    }
    const N = items.length || 1;
    const scored = items.map(it => {
        const n = norm(it.nom + ' ' + it.collection);
        let sc = 0;
        for (const w of words) if (n.includes(w) && ((freq[w] || 0) / N) < 0.3) sc++;
        return { it, sc };
    }).filter(x => brandGuard(x.it, sourceText)).sort((a, b) => b.sc - a.sc);
    const top = scored[0], second = scored[1];
    if (!top || top.sc < 2 || (second ? top.sc - second.sc < 1 : false)) return null;
    return top.it;
}

// ─── Point d'entrée ───
module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Utilise POST' });
    const t0 = Date.now();
    try {
        if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'Clé IA absente dans Vercel (GROQ_API_KEY)' });
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const query = String(body.query || '').slice(0, 300).trim();
        const imageData = typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : null;
        if (!query && !imageData) return res.status(400).json({ error: 'Question vide (et pas de photo)' });
        const history = (Array.isArray(body.history) ? body.history : [])
            .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.length < 2000)
            .slice(-6).map(h => ({ role: h.role, content: h.content }));

        const hostHeader = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'www.actionarchive.ink';

        // ─── PASSE 1 ───
        let imgDesc = '', photoNote = '';
        const p1 = await Promise.all([
            imageData && process.env.GEMINI_API_KEY
                ? geminiVision(imageData, 'Décris CETTE pièce de collection vintage de façon FACTUELLE (type, marque ou fabricant VISIBLE ou probable — avec ton incertitude, époque, texte imprimé visible, état apparent : jaunement, plis, usure). Ne conclus PAS reproduction/original (impossible par photo). Marque incertaine ? Écris-le. Français, 7 lignes max.')
                : Promise.resolve(''),
            query ? searchDDG(query) : Promise.resolve([])
        ]);
        imgDesc = p1[0];
        if (imageData && !process.env.GEMINI_API_KEY) photoNote = 'La variable GEMINI_API_KEY est absente de Vercel — ajoute-la (gratuit : aistudio.google.com) pour activer les photos';
        let results1 = p1[1];
        if (!query && imageData) results1 = await searchDDG(imgDesc.slice(0, 160));
        const photoFailed = imageData && !imgDesc;

        const harv1 = await passFetch(query || 'figurine vintage', results1);

        // ─── PASSE 2 ───
        let refineId = '', results2 = [], harv2 = { prices: [], read: 0, total: 0 };
        let lulu = { prices: [], listings: [] };
        if (Date.now() - t0 < BUDGET_MS) {
            const r = await refinePass(query, imgDesc, '');
            refineId = r.identification;
            const refined = (r.query || '').trim();
            if (refined && Date.now() - t0 < BUDGET_MS + 1500) {
                results2 = await searchDDG(refined);
                const [h2, luluRes] = await Promise.allSettled([
                    passFetch(refined, results2),
                    luluHarvest(refined.split(' ').slice(0, 8).join(' '))
                ]);
                if (h2.status === 'fulfilled') harv2 = h2.value;
                if (luluRes.status === 'fulfilled') lulu = luluRes.value;
            }
        }

        // ─── Fusion ───
        const seen = new Set(); const merged = [];
        [...results1, ...results2].forEach(r => { if (!seen.has(r.url)) { seen.add(r.url); merged.push(r); } });

        const pk = {}; const pushPrice = x => { if (x && x.p) pk[x.p.toFixed(2) + '|' + x.src] = x; };
        [...harv1.prices, ...harv2.prices, ...lulu.prices].forEach(pushPrice);
        // Les extraits DDG eux-mêmes (souvent des prix d'adjudication)
        merged.slice(0, 8).forEach(r => {
            convPush(extractPrices(stripTags((r.title || '') + ' ' + (r.snippet || ''))), 'extrait de recherche', [], 3, '');
        });
        const prices = Object.values(pk).sort((a, b) => a.p - b.p).slice(0, 18);

        let context = '';
        if (merged.length) {
            context = '\n\nRésultats de recherche web (2 passes) :\n' +
                merged.slice(0, 8).map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n');
        } else {
            context = '\n\n(Aucun résultat web — réponds avec ton expertise en le signalant.)';
        }

        const readInfo = 'pages lues : ' + (harv1.read + harv2.read) + '/' + (harv1.total + harv2.total) + ' (sources bloquées ignorées)';
        let priceCtx = '';
        if (prices.length) {
            const arr = prices.map(x => x.p);
            const med = arr[Math.floor(arr.length / 2)];
            const p75 = arr[Math.floor(arr.length * 0.75)];
            const max = arr[arr.length - 1];
            priceCtx = '\n\nPRIX OBSERVÉS (' + readInfo + ' — triés croissant, € convertis) : min ' + arr[0].toFixed(2).replace('.', ',') + ' € · médiane ' + med.toFixed(2).replace('.', ',') + ' € · 75e centile ' + p75.toFixed(2).replace('.', ',') + ' € · maximum ' + max.toFixed(2).replace('.', ',') + ' €\n' +
                prices.map(pr => '• ' + pr.p.toFixed(2).replace('.', ',') + ' €' + (pr.orig || '') + ' ← ' + pr.src).join('\n') +
                (arr.length < 5 ? '\nⓘ Peu de relevés fiables — ta fourchette experte peut être plus juste ; dis-le.' : '');
        } else {
            priceCtx = '\n\n(' + readInfo + ') AUCUN prix exploitable — fourchette experte + dis-le clairement.';
        }
        if (lulu.listings.length) {
            context += '\n\nVentes spécialisées consultées (Lulu-Berlu) : ' + lulu.listings.map(l => l.title).join(' | ');
        }

        // ─── Catalogue ───
        const catalog = await ownCatalog(hostHeader);
        const shopItem = matchCatalogItem(catalog, { q: query, d: imgDesc });
        let shopCtx = '';
        if (shopItem) {
            const linkRel = 'produit.html?id=' + shopItem.id;
            shopCtx = '\n\n★ CATALOGUE ACTION ARCHIVE — reproduction neuve équivalente EN VENTE : « ' + shopItem.nom + ' » (' + (shopItem.collection || '—') + ') — PRIX BOUTIQUE RÉEL : ' + shopItem.prix.toFixed(2).replace('.', ',') + ' € — lien : ' + linkRel + '\nLigne REPRODUCTION : donne EXACTEMENT ce prix + "fiche produit".';
            results1.unshift({ title: 'Action Archive — ' + shopItem.nom, url: 'https://' + hostHeader + '/' + linkRel, snippet: 'Reproduction neuve en vente sur le site' });
        } else if (catalog.length) {
            shopCtx = '\n\n★ CATALOGUE ACTION ARCHIVE : aucune reproduction équivalente → ligne REPRODUCTION = "non proposée au catalogue".';
        }

        // ─── Réponse finale ───
        const questionFull = (query || (imgDesc ? 'Estime la pièce analysée en photo.' : 'J\'ai joint une photo de ma pièce.')) +
            (imgDesc ? '\n\nDescription factuelle (photo) : ' + imgDesc : '') +
            (refineId ? '\n\nPrécision (passe 2) : ' + refineId : '') +
            shopCtx + context + priceCtx;
        const questionLite = (query || (imgDesc ? 'Estime la pièce (Reproduction / Loose / MIB-NRFB).' : 'Identifie et estime la pièce.')) +
            (imgDesc ? '\nDescription : ' + imgDesc.slice(0, 300) : '') +
            shopCtx + priceCtx;
        const model = await pickTextModel();
        const base = [ { role: 'system', content: SYSTEM_PROMPT }, ...history ];
        let reply = await chat(model, [...base, { role: 'user', content: questionFull }], 900,
            [...base, { role: 'user', content: questionLite }]);

        if (photoFailed && photoNote) reply += '\n\n⚠️ Détail technique : ' + photoNote;
        return res.status(200).json({
            reply,
            photoNote,
            priceCount: prices.length,
            luluCount: lulu.prices.length,
            matchedShop: shopItem ? { name: shopItem.nom, price: shopItem.prix, id: shopItem.id } : null,
            sources: results1.map(r => ({ title: r.title, url: r.url }))
        });
    } catch (err) {
        console.error('agent-search:', err);
        return res.status(500).json({ error: err.message || 'Erreur serveur' });
    }
};
