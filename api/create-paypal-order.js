// api/create-paypal-order.js — crée une commande PayPal et renvoie le lien d'approbation
module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Méthode non autorisée' });

    try {
        const { amount, orderId, description } = req.body || {};
        if (!amount || !orderId) return res.status(400).json({ success: false, error: 'amount/orderId manquant' });

        const clientId = process.env.PAYPAL_CLIENT_ID || process.env.PAYPAL_CLIENTID || process.env.PAYPAL_CLIENT;
        const secret   = process.env.PAYPAL_SECRET   || process.env.PAYPAL_CLIENT_SECRET || process.env.PAYPAL_SECRET_KEY;
        const base = process.env.PAYPAL_API_URL || (String(process.env.PAYPAL_MODE || 'sandbox').toLowerCase() === 'live'
            ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

        if (!clientId || !secret) return res.status(500).json({ success: false, error: 'Variables PayPal absentes sur Vercel' });

        const auth = Buffer.from(clientId + ':' + secret).toString('base64');

        const tokenRes = await fetch(base + '/v1/oauth2/token', {
            method: 'POST',
            headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=client_credentials'
        });
        const token = await tokenRes.json();
        if (!token.access_token) return res.status(500).json({ success: false, error: 'Token PayPal impossible' });

        const orderRes = await fetch(base + '/v2/checkout/orders', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token.access_token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                intent: 'CAPTURE',
                purchase_units: [{
                    amount: { currency_code: 'EUR', value: Number(amount).toFixed(2) },
                    custom_id: orderId,
                    description: (description || 'Action Archive').slice(0, 127)
                }],
                application_context: {
                    brand_name: 'Action Archive',
                    user_action: 'PAY_NOW',
                    shipping_preference: 'NO_SHIPPING',
                    return_url: process.env.PAYPAL_RETURN_URL || 'https://www.actionarchive.ink/index.html',
                    cancel_url: process.env.PAYPAL_CANCEL_URL || 'https://www.actionarchive.ink/panier.html'
                }
            })
        });
        const order = await orderRes.json();
        const approvalUrl = order.links && order.links.find(l => l.rel === 'approve');

        if (!order.id || !approvalUrl) {
            return res.status(500).json({ success: false, error: (JSON.stringify(order) || '').slice(0, 300) });
        }
        return res.status(200).json({ success: true, orderId: order.id, approvalUrl: approvalUrl.href });
    } catch (err) {
        console.error('PayPal create-order:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
};
