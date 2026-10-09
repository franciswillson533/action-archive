export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://action-archive.com');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { messages } = req.body;

        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Messages manquants ou invalides' });
        }

        const ashnaResponse = await fetch('https://api.ashna.ai/v1/api/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJhZ2VudElkIjoiNmFjOTVkYzQ4YjlmNDQwY2ExOTkyMjU4IiwidXNlcklkIjoiNmFjNmQ1MzMwNjRlZGFkMDBiNWJkMDU3IiwiYWxsb3dlZE9yaWdpbnMiOlsid3d3LmFjdGlvbmFyY2hpdmUuaW5rIl0sIm9yaWdpbkRvbWFpbiI6Ind3dy5hY3Rpb25hcmNoaXZlLmluayIsImFzc2lnbmVkT3JnSWQiOiIiLCJpYXQiOjE3OTE1ODI4MDgsImlzcyI6ImFzaG5hQUkiLCJhdWQiOiJhc2huYUFJIiwic3ViIjoiNmFjOTVkYzQ4YjlmNDQwY2ExOTkyMjU4In0.MhV2x6pKtxKlDx5Ukr0lGNvsb9XIatJ6L103ZovirwY'
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
                error: data.error?.message || data.message || 'Erreur Ashna API' 
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
