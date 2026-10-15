// api/agent-search.js — Texte: Groq (gratuit) · Photos: Gemini (gratuit) · Recherche: DuckDuckGo (gratuit)
const SYSTEM_PROMPT = `Tu es Action Archive-Bot, un expert mondial en jouets vintage, figurines de collection et rétrogaming des années 1970 à 2000. Ton but est d'aider l'utilisateur à identifier des jouets, estimer leur rareté, leur état (Loose, MIB, NRFB) et leur valeur historique. Si une photo est fournie, commence par ce que tu y vois (objet, marque probable, époque, état apparent, variantes visibles) avant l'estimation. Utilise toujours les résultats de recherche web fournis pour donner des estimations de prix réalistes et à jour. Sois passionné, précis, et mentionne les variantes connues (ex: variations de couleur, pays de fabrication) si elles impactent la valeur. Réponds toujours en français, structuré et concise (12 lignes maximum). Si les résultats sont vides ou insuffisants, dis-le et donne ton estimation avec réserves. Termine par "Sources utilisées : [n°1]..." si tu t'es appuyé sur les résultats.`;

const PREF_TEXT = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-70b-versatile'];

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];

let modelsCache = null, textPick = null;
const ddgCache = new Map();
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
            // Si un modèle n'existe pas, on tente le suivant : mais si c'est un problème de clé/quota,
            // on arrête tout de suite pour afficher la vraie cause
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

        // 1) PHOTO → analyse Gemini
        let imgDesc = '', photoNote = '';
        if (imageData) {
            if (process.env.GEMINI_API_KEY) {
                try {
                    imgDesc = await geminiVision(imageData,
                        'Identifie cette pièce de collection vintage (figurine, jouet ou boîte : type, marque/fabricant probable, époque, état apparent, variantes visibles). Français, 6 lignes max, sans décorum.');
                } catch (e) {
                    imgDesc = ''; photoNote = 'Gemini a échoué : ' + e.message;
                }
            } else {
                photoNote = 'La variable GEMINI_API_KEY est absente de Vercel — ajoute-la (gratuit : aistudio.google.com) pour activer les photos';
            }
        }
        const photoFailed = imageData && !imgDesc;

        // 2) Recherche web
        let searchQuery = (query + ' ' + imgDesc).trim().slice(0, 200);
        const results = await searchDDG(searchQuery || query || 'figurine vintage 1970 1980');
        const context = results.length
            ? '\n\nRésultats de recherche web (DuckDuckGo — source de vérité pour les prix) :\n' +
              results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n')
            : '\n\n(Aucun résultat web disponible — réponds avec ton expertise en le signalant.)';

        // 3) Réponse finale (Groq) — puis l'erreur technique brute, NON paraphrasée
        const question = (query || 'J\'ai joint une photo de ma pièce.') +
            (imgDesc ? '\n\nIdentification de la photo (analyse Gemini) : ' + imgDesc : '') + context;
        const model = await pickTextModel();
        let reply = await chat(model, [ { role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: question } ], 700);

        if (photoFailed && photoNote) reply += '\n\n⚠️ Détail technique : ' + photoNote;
        return res.status(200).json({ reply, photoNote, sources: results.map(r => ({ title: r.title, url: r.url })) });
    } catch (err) {
        console.error('agent-search:', err);
        return res.status(500).json({ error: err.message || 'Erreur serveur' });
    }
};
