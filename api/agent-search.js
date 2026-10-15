// api/agent-search.js — Groq (texte) · Gemini (photos) · DuckDuckGo + PRIX RÉELS (eBay vendus) + catalogue
const SYSTEM_PROMPT = `Tu es Action Archive-Bot, un expert mondial en jouets vintage, figurines de collection et rétrogaming des années 1970 à 2000. Ton but : aider l'utilisateur à identifier des jouets, estimer leur rareté, leur état (Loose, MIB, NRFB) et leur valeur historique.

RÈGLES D'ESTIMATION (primordiales) :
- Les PRIX OBSERVÉS extraits (ventes soldées et annonces) sont ta base prioritaire ; cite la provenance. N'invente JAMAIS de nom d'outil ou de système interne ("readWebUrlTool", etc. interdits) — parle des "pages consultées".
- Marchés SÉPARÉS pour un même jouet : (a) reproduction neuve, (b) original Loose, (c) original MIB/NRFB — en boîte complète, compte souvent 3 à 10 fois le Loose.
- MIB/NRFB : calcule ta fourchette dans la MOITIÉ SUPÉRIEURE des relevés : du 75e centile (donné) au maximum observé (donné). Ne prends JAMAIS le bas des relevés pour un exemplaire en boîte. ÉTIQUETTE OBLIGATOIRE : "MIB/NRFB : X–Y € (fourchette basse du marché — ventes exceptionnelles, états supérieurs ou raretés : au-dessus)". Loose : "(marché courant)".
- Devise : convertis £/$ en € (1 £ ≈ 1,17 € ; 1 $ ≈ 0,92 €) et garde la devise d'origine entre parenthèses.
- Ligne REPRODUCTION : si une pièce de la MÊME marque et du MÊME type figure dans le CATALOGUE ACTION ARCHIVE (données), donne EXACTEMENT ce prix boutique et ce lien relatif. S'il y a le moindre doute (marque ou type différent), pas de lien, pas de prix catalogue.
- Interdits : phrases génériques, rappels d'astuces, formules creuses. Seuls les chiffres concrets comptent.

STYLE : français, passionné, 4 blocs sur 14 lignes max :
IDENTIFICATION · PRIX OBSERVÉS (courte liste avec provenance) · ESTIMATION (Reproduction / Loose / MIB-NRFB, fourchettes étiquetées) · CONSEIL (UNE seule ligne).
"Aucun prix exploitable" → dis-le et fourchette indicative avec réserves.
Ligne "Sources utilisées : ..." UNIQUEMENT si des sources ont réellement servi ; sinon ne l'écris pas du tout.`;

const PREF_TEXT = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-70b-versatile'];

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash'];

let modelsCache = null, textPick = null, catCache = null;
const ddgCache = new Map();
const priceCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

async function getGroqModels() {
    if (modelsCache && Date.now() - modelsCache.t < 10 * 60 * 1000) return modelsCache.ids;
    const res = await fetch(GROQ_BASE + '/models', { headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY } });
    if (!res.ok) {
        if (res.status === 401) throw new Error('Clé Groq INVALIDE — vérifie GROQ_API_KEY dans Vercel');
        throw new Error('Modèles Groq indisponibles (HTTP ' + res.status + ')');
    }
    const data = await res.json();
    const ids = (data.data || []).map(x => x.id);
    if (!ids.length) throw new Error('Ta clé Groq n\'expose aucun modèle');
    modelsCache = { t: Date.now(), ids };
    return ids;
}

async function pickTextModel() {
    if (textPick) return textPick;
    const ids = await getGroqModels();
    textPick = (PREF_TEXT.find(p => ids.includes(p)) || ids.find(i => /llama|instant|versatile|instruct/i.test(i)) || ids[0]) || null;
    return textPick;
}

async function chat(model, messages, maxTokens) {
    const res = await fetch(GROQ_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0.55, max_tokens: maxTokens, messages })
    });
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) {
        if ((data.error && data.error.code === 'model_not_found') || /model/i.test((data.error && data.error.message) || '')) textPick = null;
        throw new Error((data.error && data.error.message) || 'Réponse Groq vide');
    }
    return content;
}

// ─── Gemini : analyse des photos ───
async function geminiVision(dataUrl, prompt) {
    const m = dataUrl.match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i);
    if (!m) throw new Error('Image illisible');
    let lastErr = '';
    for (const model of GEMINI_MODELS) {
        try {
            const res = await fetch(GEMINI_BASE + '/' + model + ':generateContent?key=' + encodeURIComponent(process.env.GEMINI_API_KEY), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [ { text: prompt }, { inline_data: { mime_type: m[1], data: m[2] } } ] }]
                })
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
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Accept-Language': 'fr-fr,fr;q=0.9' }
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
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Accept-Language': 'fr-fr,fr;q=0.9' }
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

// ─── PRIX RÉELS : priorité aux VENTES SOLDÉES eBay ───
async function fetchPageText(url, timeoutMs) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs || 3000);
    try {
        const res = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'fr-fr,fr;q=0.9' }
        });
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
    while ((m = re.exec(text)) && found.length < 10) {
        const raw = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
        if (!raw) continue;
        const num = parseFloat(raw.replace(/[ .](?=\d{3}\b)/g, '').replace(',', '.'));
        if (!isNaN(num) && num >= 1 && num <= 25000) found.push(num);
    }
    return found;
}

async function harvestPrices(query, results) {
    const hit = priceCache.get(query.toLowerCase());
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.prices;
    const kw = encodeURIComponent(query.slice(0, 110));
    const targets = [
        { url: 'https://www.ebay.fr/sch/i.html?_nkw=' + kw + '&LH_Complete=1&LH_Sold=1', src: 'eBay FR — ventes soldées' },
        { url: 'https://www.ebay.com/sch/i.html?_nkw=' + kw + '&LH_Complete=1&LH_Sold=1', src: 'eBay COM — ventes soldées' },
        { url: 'https://www.ebay.fr/sch/i.html?_nkw=' + kw + '&_sop=16', src: 'eBay FR — annonces courantes' },
        { url: results[0] ? results[0].url : '', src: 'source web 1' },
        { url: results[1] ? results[1].url : '', src: 'source web 2' },
        { url: results[2] ? results[2].url : '', src: 'source web 3' }
    ].filter(t => t.url);
    const settled = await Promise.allSettled(targets.map(t => fetchPageText(t.url, 3000)));
    const prices = [];
    for (let i = 0; i < settled.length && prices.length < 16; i++) {
        if (settled[i].status !== 'fulfilled' || !settled[i].value) continue;
        const found = extractPrices(settled[i].value);
        found.forEach(p => {
            let pe = p;
            const srcS = targets[i].src || '';
            if (/£|GBP/.test(srcS)) pe = p * 1.17;
            else if (/USD|\$/.test(srcS)) pe = p * 0.92;
            prices.push({ p: Math.round(pe * 100) / 100, src: targets[i].src, cur: targets[i].src });
        });
    }
    prices.sort((a, b) => a.p - b.p);
    const out = prices.slice(0, 16);
    priceCache.set(query.toLowerCase(), { t: Date.now(), prices: out });
    return out;
}

// ─── Catalogue boutique ───
function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
async function ownCatalog(host) {
    try {
        if (catCache && Date.now() - catCache.t < CACHE_TTL) return catCache.items;
        const res = await fetch('https://' + host + '/api/airtable-proxy', { headers: { 'User-Agent': 'AA-Agent/1.0' } });
        if (!res.ok) return [];
        const data = await res.json();
        const items = (Array.isArray(data) ? data : []).map(r => {
            const f = r.fields || r;
            return {
                id: r.id,
                nom: f.Nom || '',
                collection: f.Collection || '',
                annee: parseInt(f.Année) || 0,
                prix: parseFloat(f.Prix) || 0
            };
        }).filter(x => x.nom && x.prix > 0);
        catCache = { t: Date.now(), items };
        return items;
    } catch (e) { return []; }
}

const BRANDS = ['mego', 'meccano', 'palitoy', 'mattel', 'big jim', 'gi joe', 'gijoe', 'hasbro', 'ceji', 'arbois', 'popy', 'action man', 'action joe', 'kenner', 'matchbox', 'creta', 'lone star', 'gama', 'cherilea', 'britains', 'timpo', 'starlux'];
function brandGuard(item, texto) {
    const t = norm(texto);
    const mentioned = BRANDS.filter(b => t.includes(norm(b)));
    if (mentioned.length === 0) return true;
    const n = norm(item.nom + ' ' + item.collection);
    return mentioned.some(b => n.includes(norm(b)));
}
let __matchCtx = { q: '', d: '' };
function matchCatalogItem(items) {
    const texto = __matchCtx;
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
        for (const w of words) {
            if (n.includes(w) && ((freq[w] || 0) / N) < 0.3) sc++;
        }
        const yearInQuery = (words.find(w => /^(19[7-9]\d|200\d)$/.test(w)) || '');
        if (yearInQuery && it.annee === parseInt(yearInQuery)) sc += 2;
        return { it, sc };
    }).filter(x => brandGuard(x.it, sourceText)).sort((a, b) => b.sc - a.sc);
    const top = scored[0], second = scored[1];
    if (!top || top.sc < 2 || (second ? top.sc - second.sc < 1 : false)) return null;
    return top.it;
}

// ─── Point d'entrée ───
module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Utilise POST' });
    try {
        if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'Clé GROQ_API_KEY absente dans Vercel (Environment Variables)' });
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const query = String(body.query || '').slice(0, 300).trim();
        const imageData = typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : null;
        if (!query && !imageData) return res.status(400).json({ error: 'Question vide (et pas de photo)' });
        const history = (Array.isArray(body.history) ? body.history : [])
            .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.length < 2000)
            .slice(-6).map(h => ({ role: h.role, content: h.content }));

        const hostHeader = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || 'www.actionarchive.ink';

        // 1) PHOTO → identification Gemini
        let imgDesc = '', photoNote = '';
        if (imageData) {
            if (process.env.GEMINI_API_KEY) {
                try {
                    imgDesc = await geminiVision(imageData,
                        'Identifie cette pièce de collection vintage (figurine, jouet ou boîte : type, marque/fabricant probable, époque, état apparent, variantes visibles). Indique aussi si l\'objet semble être une impression neuve (reproduction) ou un article vintage d\'origine. Français, 7 lignes max, sans décorum. Marque incertaine ? Écris-le, ne conjecture pas.');
                } catch (e) {
                    imgDesc = ''; photoNote = 'Gemini a échoué : ' + e.message;
                }
            } else {
                photoNote = 'La variable GEMINI_API_KEY est absente de Vercel — ajoute-la (gratuit : aistudio.google.com) pour activer les photos';
            }
        }
        const photoFailed = imageData && !imgDesc;

        const combo = (query + ' ' + imgDesc).trim();

        // 2) Recherche web
        let searchQuery = combo.slice(0, 200);
        const results = await searchDDG(searchQuery || query || 'figurine vintage 1970 1980');
        const context = results.length
            ? '\n\nRésultats de recherche web (DuckDuckGo) :\n' +
              results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n')
            : '\n\n(Aucun résultat web disponible — réponds avec ton expertise en le signalant.)';

        // 2b) PRIX : ventes soldées en priorité + stats hautes
        const prices = await harvestPrices(searchQuery || query || 'figurine vintage', results);
        let priceCtx = '';
        if (prices.length) {
            const arr = prices.map(x => x.p);
            const med = arr[Math.floor(arr.length / 2)];
            const p75 = arr[Math.floor(arr.length * 0.75)];
            const max = arr[arr.length - 1];
            priceCtx = '\n\nPRIX OBSERVÉS (' + arr.length + ' relevés, € convertis) : min ' + arr[0].toFixed(2).replace('.', ',') + ' € · médiane ' + med.toFixed(2).replace('.', ',') + ' € · 75e centile ' + p75.toFixed(2).replace('.', ',') + ' € · maximum ' + max.toFixed(2).replace('.', ',') + ' €\n' +
                prices.map(pr => '• ' + pr.p.toFixed(2).replace('.', ',') + ' € ← ' + (pr.src || 'source')).join('\n') +
                '\n(MIB/NRFB = zone 75e centile → maximum ; Loose = zone basse/médiane.)';
        } else {
            priceCtx = '\n\n(Aucun prix exploitable trouvé — fourchette indicative + signale-le clairement.)';
        }

        // 2c) CATALOGUE : prix boutique réel + lien RELATIF
        __matchCtx = { q: query, d: imgDesc };
        const catalog = await ownCatalog(hostHeader);
        const shopItem = matchCatalogItem(catalog);
        let shopCtx = '';
        if (shopItem) {
            const linkRel = 'produit.html?id=' + shopItem.id;
            shopCtx = '\n\n★ CATALOGUE ACTION ARCHIVE — reproduction neuve équivalente EN VENTE : « ' + shopItem.nom + ' » (' + (shopItem.collection || '—') + (shopItem.annee ? ' · ' + shopItem.annee : '') + ') — PRIX BOUTIQUE : ' + shopItem.prix.toFixed(2).replace('.', ',') + ' € — lien : ' + linkRel + '\nLigne REPRODUCTION : donne EXACTEMENT ce prix et cite ce lien relatif tel quel.';
            results.unshift({ title: 'Action Archive — ' + shopItem.nom, url: 'https://' + hostHeader + '/' + linkRel, snippet: 'Reproduction neuve en vente sur le site' });
        }

        // 3) Réponse finale
        const question = (query || (imgDesc ? 'Estime la pièce analysée en photo.' : 'J\'ai joint une photo de ma pièce.')) +
            (imgDesc ? '\n\nIdentification de la photo (analyse Gemini) : ' + imgDesc : '') + shopCtx + context + priceCtx;
        const model = await pickTextModel();
        let reply = await chat(model, [ { role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: question } ], 900);

        if (photoFailed && photoNote) reply += '\n\n⚠️ Détail technique : ' + photoNote;
        return res.status(200).json({
            reply,
            photoNote,
            priceCount: prices.length,
            matchedShop: shopItem ? { name: shopItem.nom, price: shopItem.prix, id: shopItem.id } : null,
            sources: results.map(r => ({ title: r.title, url: r.url }))
        });
    } catch (err) {
        console.error('agent-search:', err);
        return res.status(500).json({ error: err.message || 'Erreur serveur' });
    }
};
