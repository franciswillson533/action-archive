// api/agent-search.js — Recherche DuckDuckGo (gratuit, sans clé) + cerveau Groq (gratuit)
const SYSTEM_PROMPT = `Tu es Action Archive-Bot, un expert mondial en jouets vintage, figurines de collection et rétrogaming des années 1970 à 2000. Ton but est d'aider l'utilisateur à identifier des jouets, estimer leur rareté, leur état (Loose, MIB, NRFB) et leur valeur historique. Utilise toujours les résultats de recherche web fournis pour donner des estimations de prix réalistes et à jour. Sois passionné, précis, et mentionne les variantes connues (ex: variations de couleur, pays de fabrication) si elles impactent la valeur. Réponds toujours en français, de façon structurée et concise (12 lignes maximum). Si les résultats de recherche sont vides ou insuffisants, dis-le et donne ton estimation avec les réserves d'usage. Termine par une ligne "Sources utilisées : [n°1], [n°2]..." si tu t'es appuyé sur les résultats.`;

// Modèle Groq : changer ici si besoin (liste dispo: curl https://api.groq.com/openai/v1/models)
const GROQ_MODEL = 'llama-3.1-8b-instant';

const ddgCache = new Map(); // cache mémoire : les mêmes recherches servent tous les visiteurs
const CACHE_TTL = 60 * 60 * 1000; // 1 h

function stripTags(s) {
    return String(s || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&#x2F;/g, '/')
        .replace(/\s+/g, ' ').trim();
}

// Les liens DDG passent parfois par un redirect : on en extrait la vraie destination
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
    const snips = [];
    let m;
    const snipRe = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
    while ((m = snipRe.exec(html))) snips.push(stripTags(m[1]));
    const out = [];
    let i = 0;
    const linkRe = /<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
    for (const match of html.matchAll(linkRe)) {
        const href = match[1];
        if (/y\.js|duckduckgo\.com\/y/.test(href)) { i++; continue; } // pubs
        const url = decodeDdg(href);
        if (!/^https?:\/\//.test(url)) { i++; continue; }
        out.push({ title: stripTags(match[2]).slice(0, 120), url, snippet: (snips[i] || '').slice(0, 220) });
        i++;
        if (out.length >= 6) break;
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
    const hit = ddgCache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.r;
    let results = [];
    try { results = await ddgLite(key); } catch (e) {}
    if (results.length === 0) { try { results = await ddgHtml(key); } catch (e) {} } // plan B si Lite fatigué
    ddgCache.set(key, { t: Date.now(), r: results });
    return results;
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Utilise POST' });
    try {
        if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'Clé GROQ_API_KEY absente dans Vercel (Environment Variables)' });
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const query = String(body.query || '').slice(0, 300).trim();
        if (!query) return res.status(400).json({ error: 'Question vide' });
        const history = (Array.isArray(body.history) ? body.history : [])
            .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.length < 2000)
            .slice(-6).map(h => ({ role: h.role, content: h.content }));

        const results = await searchDDG(query);
        const context = results.length
            ? '\n\nRésultats de recherche web (DuckDuckGo — source de vérité pour les prix) :\n' +
              results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n')
            : '\n\n(Aucun résultat web disponible — réponds avec ton expertise en le signalant.)';

        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: GROQ_MODEL,
                temperature: 0.55,
                max_tokens: 700,
                messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history, { role: 'user', content: `Question : "${query}"${context}` }]
            })
        });
        const data = await groqRes.json();
        const reply = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
        if (!reply) {
            const errTxt = (data.error && (data.error.message || JSON.stringify(data.error))) || 'Réponse Groq vide';
            return res.status(500).json({ error: errTxt });
        }
        return res.status(200).json({ reply, sources: results.map(r => ({ title: r.title, url: r.url })) });
    } catch (err) {
        console.error('agent-search:', err);
        return res.status(500).json({ error: err.message || 'Erreur serveur' });
    }
};
