// api/agent-search.js — Groq (texte) · Gemini (photos) · DuckDuckGo + prix réels + catalogue boutique
const SYSTEM_PROMPT = `Tu es Action Archive-Bot, un expert mondial en jouets vintage, figurines de collection et rétrogaming des années 1970 à 2000. Ton but : aider l'utilisateur à identifier des jouets, estimer leur rareté, leur état (Loose, MIB, NRFB) et leur valeur historique.

RÈGLES D'ESTIMATION (primordiales) :
- Les PRIX OBSERVÉS extraits des pages sources sont ta base prioritaire ; cite la provenance, sans inventer de nom d'outil ou de système interne.
- Un même jouet a des MARCHÉS SÉPARÉS : (a) reproduction/impression neuve, (b) original Loose, (c) original MIB ou NRFB — souvent 3 à 10 fois le prix Loose. Prends le HAUT des relevés pour les exemplaires complets, le bas pour les Loose.
- Ligne REPRODUCTION : si une pièce identique figure dans le CATALOGUE ACTION ARCHIVE (indiqué dans les données), donne EXACTEMENT ce prix boutique — ne l'estime jamais. Sinon, fourchette prudente et marquée comme indicative.
- Jamais de phrases génériques ou de rappels d'astuces : seuls les chiffres concrets comptent.

STYLE : français, passionné, structuré en 4 blocs sur 14 lignes max :
IDENTIFICATION · PRIX OBSERVÉS (courte liste avec provenance) · ESTIMATION (Reproduction / Loose / MIB-NRFB, fourchettes) · CONSEIL (UNE seule ligne : le piège ou la variante la plus décisive).
Si aucun prix exploitable n'a été trouvé, dis-le et donne une fourchette indicative avec réserves explicites.
Écris la ligne "Sources utilisées : ..." UNIQUEMENT si tu as réellement utilisé des sources numérotées ; autrement, ne l'écris pas du tout.`;

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

// ─── Extraction de PRIX RÉELS ───
async function fetchPageText(url, timeoutMs) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs || 3500);
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
    while ((m = re.exec(text)) && found.length < 8) {
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
    const targets = [
        'https://www.ebay.fr/sch/i.html?_nkw=' + encodeURIComponent(query.slice(0, 110)),
        'https://www.ebay.com/sch/i.html?_nkw=' + encodeURIComponent(query.slice(0, 110))
    ];
    results.slice(0, 3).forEach(r => targets.push(r.url));
    const settled = await Promise.allSettled(targets.map(u => fetchPageText(u, 3500)));
    const prices = [];
    for (let i = 0; i < settled.length && prices.length < 12; i++) {
        if (settled[i].status !== 'fulfilled' || !settled[i].value) continue;
        const found = extractPrices(settled[i].value);
        found.forEach(p => prices.push({ p, src: targets[i] }));
    }
    prices.sort((a, b) => a.p - b.p);
    const out = prices.slice(0, 12);
    priceCache.set(query.toLowerCase(), { t: Date.now(), prices: out });
    return out;
}

// ─── Catalogue boutique : les MÊMES champs que la page produits.html (Nom, Collection, Année, Prix) ───
function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
async function ownCatalog(host) {
    try {
        if (catCache && Date.now() - catCache.t < CACHE_TTL) return catCache.items;
        const res = await fetch('https://' + host + '/api/airtable-proxy', {
            headers: { 'User-Agent': 'AA-Agent/1.0' }
        });
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

function matchCatalogItem(items, texto) {
    const words = norm(texto).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3);
    if (!words.length || !items.length) return null;
    // Poids : un mot qui revient sur >30 % du catalogue ne compte pas (soldat, russe, figurine…)
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
        // Une année en 4 chiffres (1970-2000) qui correspond exactement au produit pèse lourd
        const yearInQuery = (words.find(w => /^(19[7-9]\d|200\d)$/.test(w)) || '');
        if (yearInQuery && it.annee === parseInt(yearInQuery)) sc += 2;
        return { it, sc };
    }).sort((a, b) => b.sc - a.sc);
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

        // 1) PHOTO → identification par Gemini
        let imgDesc = '', photoNote = '';
        if (imageData) {
            if (process.env.GEMINI_API_KEY) {
                try {
                    imgDesc = await geminiVision(imageData,
                        'Identifie cette pièce de collection vintage (figurine, jouet ou boîte : type, marque/fabricant probable, époque, état apparent, variantes visibles). Indique aussi si l\'objet semble être une impression neuve (reproduction, carton non fatigué) ou un article vintage d\'origine. Français, 7 lignes max, sans décorum.');
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

        // 2b) PRIX RÉELS
        const prices = await harvestPrices(searchQuery || query || 'figurine vintage', results);
        let priceCtx = '';
        if (prices.length) {
            priceCtx = '\n\nPRIX OBSERVÉS (extraction automatique, triés du plus bas au plus haut — ' + prices.length + ' relevés, entre ' + prices[0].p.toFixed(2).replace('.', ',') + ' € et ' + prices[prices.length - 1].p.toFixed(2).replace('.', ',') + ' €) :\n' +
                prices.map(pr => '• ' + pr.p.toFixed(2).replace('.', ',') + ' ← ' + pr.src).join('\n');
        } else {
            priceCtx = '\n\n(Aucun prix exploitable trouvé dans les sources — fourchette indicative + signal clairement.)';
        }

        // 2c) CATALOGUE BOUTIQUE : prix réel de la reproduction (champs Nom/Collection de la page produits)
        const catalog = await ownCatalog(hostHeader);
        const shopItem = matchCatalogItem(catalog, combo || query);
        let shopCtx = '';
        if (shopItem) {
            const link = 'https://' + hostHeader + '/produit.html?id=' + shopItem.id;
            shopCtx = '\n\n★ CATALOGUE ACTION ARCHIVE : une reproduction neuve équivalente est EN VENTE dans la boutique : « ' + shopItem.nom + ' » (Collection : ' + (shopItem.collection || '—') + (shopItem.annee ? ', ' + shopItem.annee : '') + ') au prix boutique de ' + shopItem.prix.toFixed(2).replace('.', ',') + ' € — ' + link + '\nLigne REPRODUCTION : donne EXACTEMENT ce prix et partage ce lien.';
            results.unshift({ title: 'Action Archive — ' + shopItem.nom, url: link, snippet: 'Reproduction neuve en vente sur le site' });
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
