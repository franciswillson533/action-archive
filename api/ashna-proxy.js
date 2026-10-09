export default async function handler(req, res) {
    // ✅ CORS
    res.setHeader('Access-Control-Allow-Origin', 'https://actionarchive.ink');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { messages } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Messages manquants ou invalides' });
        }

        // ✅ Clé API lue depuis la variable d'environnement Vercel
        const apiKey = process.env.ASHNA_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Clé API Ashna non configurée sur le serveur' });
        }

        const ashnaResponse = await fetch('https://api.ashna.ai/v1/api/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey
            },
            body: JSON.stringify({
                model: '6ac95dc48b9f440ca1992258',
                stream: false,
                messages: messages
            })
        });

        const data = await ashnaResponse.json();

        if (!ashnaResponse.ok) {
            return res.status(ashnaResponse.status).json({ 
                error: data.error?.message || data.message || data.error || 'Erreur Ashna API' 
            });
        }

        return res.status(200).json(data);

    } catch (error) {
        console.error('Erreur proxy Ashna:', error);
        return res.status(500).json({ 
            error: 'Erreur serveur: ' + error.message 
        });
    }
}
