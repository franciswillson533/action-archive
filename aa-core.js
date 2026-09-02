const API_ENDPOINT = '/.netlify/functions/products';
const CACHE_DURATION = 60 * 60 * 1000;
const CACHE_KEY = 'aa_products_cache';
const CACHE_TIME_KEY = 'aa_products_cache_time';
const LOCAL_KEY = 'aa_local_products';

const SHADOW_COLORS = ["rgba(15,86,191,1)", "rgba(187,0,3,1)", "rgba(117,87,0,1)", "rgba(52,46,30,1)"];

const PLACEHOLDER_IMG = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500" viewBox="0 0 400 500">
    <rect width="400" height="500" fill="#eadcbc"/>
    <text x="200" y="230" text-anchor="middle" font-family="Arial Black" font-size="22" font-weight="900" fill="#635b48">ARCHIVE</text>
    <text x="200" y="270" text-anchor="middle" font-family="Arial Black" font-size="22" font-weight="900" fill="#635b48">VINTAGE</text>
    <line x1="100" y1="320" x2="300" y2="320" stroke="#bb0003" stroke-width="4"/>
    <text x="200" y="360" text-anchor="middle" font-family="Arial" font-size="14" font-weight="700" fill="#635b48">PHOTO INDISPONIBLE</text>
</svg>`);

function protectImage(img) {
    if (!img) return;
    img.setAttribute('draggable', 'false');
    img.oncontextmenu = (e) => { e.preventDefault(); return false; };
    img.onmousedown = (e) => { if (e.button === 2) e.preventDefault(); };
    img.ondragstart = (e) => { e.preventDefault(); return false; };
}
function protectAllImages() {
    document.querySelectorAll('img').forEach(protectImage);
}

async function fetchProducts(forceRefresh = false) {
    const localProducts = getLocalProducts();
    if (!forceRefresh) {
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            const cacheTime = localStorage.getItem(CACHE_TIME_KEY);
            if (cached && cacheTime) {
                const age = Date.now() - parseInt(cacheTime);
                if (age < CACHE_DURATION) {
                    const airtableProducts = JSON.parse(cached);
                    if (airtableProducts && airtableProducts.length > 0) {
                        return mergeProducts(localProducts, airtableProducts);
                    }
                }
            }
        } catch (e) {}
    }
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(API_ENDPOINT, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.ok) {
            const data = await response.json();
            const airtableProducts = Array.isArray(data) ? data : [];
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify(airtableProducts));
                localStorage.setItem(CACHE_TIME_KEY, Date.now().toString());
            } catch (e) {}
            return mergeProducts(localProducts, airtableProducts);
        }
    } catch (error) {
        console.warn('Fetch produits échoué:', error.message);
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                return mergeProducts(localProducts, JSON.parse(cached));
            }
        } catch (e) {}
    }
    return localProducts;
}

async function syncLocalToBlob() {
    const products = getLocalProducts();
    if (products.length === 0) {
        return { success: false, message: 'Aucun produit local à synchroniser' };
    }
    try {
        const response = await fetch('/.netlify/functions/sync-to-blob', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ products: products.map(p => ({ id: 'local_' + p.id, fields: p })) })
        });
        return await response.json();
    } catch (e) {
        return { success: false, message: e.message };
    }
}

function mergeProducts(localProducts, airtableProducts) {
    const seen = new Set();
    const merged = [];
    localProducts.forEach(p => {
        const key = (p.Nom || '').toLowerCase().trim();
        if (key && !seen.has(key)) {
            seen.add(key);
            merged.push({ id: 'local_' + (p.id || Date.now()), fields: p, source: 'local' });
        }
    });
    airtableProducts.forEach(p => {
        const key = ((p.fields && p.fields.Nom) || '').toLowerCase().trim();
        if (key && !seen.has(key)) {
            seen.add(key);
            merged.push(p);
        }
    });
    return merged;
}

function getLocalProducts() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); } catch (e) { return []; }
}
function saveLocalProducts(p) { localStorage.setItem(LOCAL_KEY, JSON.stringify(p)); }

function aaGetCart() { try { return JSON.parse(localStorage.getItem('aa_cart') || '[]'); } catch { return []; } }
function aaSaveCart(c) { localStorage.setItem('aa_cart', JSON.stringify(c)); aaUpdateBadge(); }
function aaAddToCart(name, price, url, image) {
    const c = aaGetCart();
    const ex = c.find(i => i.name === name);
    if (ex) ex.qty++; else c.push({ name, price: parseFloat(price), url, image, qty: 1 });
    aaSaveCart(c);
    aaToast(name + ' ajouté !', 'shopping_cart');
}
function aaRemoveFromCart(name) { aaSaveCart(aaGetCart().filter(i => i.name !== name)); if (typeof renderCart === 'function') renderCart(); }
function aaUpdateQty(name, delta) {
    const c = aaGetCart();
    const item = c.find(i => i.name === name);
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) { aaRemoveFromCart(name); return; }
    aaSaveCart(c);
    if (typeof renderCart === 'function') renderCart();
}
function aaGetCartTotal() { return aaGetCart().reduce((sum, item) => sum + (item.price * item.qty), 0); }
function aaClearCart() { localStorage.removeItem('aa_cart'); aaUpdateBadge(); }

function aaUpdateBadge() {
    const n = aaGetCart().reduce((s, i) => s + i.qty, 0);
    document.querySelectorAll('#aa-cart-badge').forEach(el => {
        el.textContent = n;
        el.style.display = n ? 'flex' : 'none';
    });
}

function aaToast(msg, icon = 'check_circle') {
    const w = document.getElementById('aa-toasts');
    if (!w) return;
    const t = document.createElement('div');
    t.className = 'aa-toast';
    t.innerHTML = `<span class="material-symbols-outlined">${icon}</span><span>${msg}</span>`;
    w.appendChild(t);
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 3000);
}

function switchImageManual(btn, recto, verso) {
    const card = btn.closest('.group');
    const img = card.querySelector('.product-img');
    if (btn.innerText === 'RECTO') { img.src = verso || recto; btn.innerText = 'VERSO'; btn.classList.replace('bg-secondary', 'bg-primary'); }
    else { img.src = recto; btn.innerText = 'RECTO'; btn.classList.replace('bg-primary', 'bg-secondary'); }
}
function handleHover(img, recto, verso) { if (!verso || verso === recto) return; img.src = verso; }
function handleLeave(img, recto) { img.src = recto; }

function getImageUrl(field) {
    if (!field) return null;
    if (typeof field === 'string') {
        if (field.startsWith('http://') || field.startsWith('https://')) return field;
        if (field.startsWith('v1/') || field.includes('cloudinary')) return 'https://res.cloudinary.com/uvnbvhiw/image/upload/' + field;
        return field;
    }
    if (Array.isArray(field)) {
        if (field.length === 0) return null;
        const first = field[0];
        if (typeof first === 'string') {
            if (first.startsWith('http')) return first;
            return 'https://res.cloudinary.com/uvnbvhiw/image/upload/' + first;
        }
        if (typeof first === 'object') {
            if (first.url) return first.url;
            if (first.secure_url) return first.secure_url;
            if (first.filename) return 'https://res.cloudinary.com/uvnbvhiw/image/upload/' + first.filename;
        }
    }
    if (typeof field === 'object') {
        if (field.url) return field.url;
        if (field.secure_url) return field.secure_url;
        if (field.filename) return 'https://res.cloudinary.com/uvnbvhiw/image/upload/' + field.filename;
    }
    return null;
}

function handleImgError(img) {
    img.onerror = null;
    img.src = PLACEHOLDER_IMG;
    img.style.objectFit = 'contain';
    img.style.background = '#eadcbc';
}

function formatPrice(price) { const num = parseFloat(price); if (isNaN(num)) return price + ' €'; return num.toFixed(2) + ' €'; }

function getWeeklyRandomProducts(products, count = 12) {
    const now = new Date();
    const weekSeed = Math.floor(now.getTime() / (1000 * 60 * 60 * 24 * 7));
    let shuffled = [...products];
    let seed = weekSeed;
    for (let i = shuffled.length - 1; i > 0; i--) {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        let j = seed % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.slice(0, count);
}

function getProductType(p) {
    const t = (p.fields?.Type || '').toLowerCase();
    if (t.includes('custom')) return 'custom';
    return 'reproduction';
}

function getProductDecade(p) {
    const year = parseInt(p.fields?.Année);
    if (!year || isNaN(year)) return null;
    if (year >= 1970 && year < 1980) return '1970';
    if (year >= 1980 && year < 1990) return '1980';
    if (year >= 1990 && year < 2000) return '1990';
    return null;
}

function getTypeBadge(type) {
    return {
        reproduction: { text: '🔵 REPRODUCTION', bg: '#0f56bf' },
        custom: { text: '🟣 CUSTOM', bg: '#7b1fa2' }
    }[type] || { text: '🔵 REPRODUCTION', bg: '#0f56bf' };
}

function toggleDrawer() {
    const drawer = document.getElementById('side-drawer');
    const overlay = document.getElementById('drawer-overlay');
    if (!drawer || !overlay) return;
    drawer.classList.toggle('open');
    overlay.classList.toggle('open');
    document.body.style.overflow = drawer.classList.contains('open') ? 'hidden' : '';
}

function getLoyaltyCustomers() { return JSON.parse(localStorage.getItem('aa_customers') || '[]'); }
function saveLoyaltyCustomers(c) { localStorage.setItem('aa_customers', JSON.stringify(c)); updateNavStars(); }
function getCustomerByEmail(email) { if (!email) return null; return getLoyaltyCustomers().find(c => c.email === email) || null; }
function recordPurchase(order) {
    const email = order.customer?.email;
    if (!email) return { customer: null, giftJustEarned: false };
    const customers = getLoyaltyCustomers();
    let customer = customers.find(c => c.email === email);
    if (!customer) {
        customer = { pseudo: order.customer.firstname || order.customer.name || 'Client', email, registeredAt: new Date().toISOString(), stars: 0, totalSpent: 0, ordersCount: 0, giftsDelivered: 0, purchaseHistory: [] };
        customers.push(customer);
    }
    customer.stars = customer.stars || 0; customer.totalSpent = customer.totalSpent || 0; customer.ordersCount = customer.ordersCount || 0; customer.giftsDelivered = customer.giftsDelivered || 0; customer.purchaseHistory = customer.purchaseHistory || [];
    const previousGiftsPending = getGiftsPending(customer);
    customer.stars += 1; customer.totalSpent += order.total; customer.ordersCount += 1;
    customer.purchaseHistory.push({ orderId: order.id, date: order.date, total: order.total, items: (order.items || []).map(i => ({ name: i.name, qty: i.qty, price: i.price })) });
    customer.lastOrderDate = order.date;
    const newGiftsPending = getGiftsPending(customer);
    const giftJustEarned = newGiftsPending > previousGiftsPending;
    saveLoyaltyCustomers(customers);
    localStorage.setItem('aa_session_email', email);
    return { customer, giftJustEarned };
}
function getGiftsPending(customer) {
    if (!customer) return 0;
    const earned = Math.floor((customer.stars || 0) / 10);
    const delivered = customer.giftsDelivered || 0;
    return Math.max(0, earned - delivered);
}
function markGiftDelivered(email) {
    const customers = getLoyaltyCustomers();
    const customer = customers.find(c => c.email === email);
    if (!customer) return false;
    if (getGiftsPending(customer) <= 0) return false;
    customer.giftsDelivered = (customer.giftsDelivered || 0) + 1;
    customer.lastGiftDeliveredDate = new Date().toISOString();
    saveLoyaltyCustomers(customers);
    return true;
}
function adjustStars(email, delta) {
    const customers = getLoyaltyCustomers();
    const customer = customers.find(c => c.email === email);
    if (!customer) return false;
    customer.stars = Math.max(0, (customer.stars || 0) + delta);
    saveLoyaltyCustomers(customers);
    return true;
}
function getCurrentUserCustomer() {
    const user = JSON.parse(localStorage.getItem('aa_user') || 'null');
    const sessionEmail = localStorage.getItem('aa_session_email');
    const email = user?.email || sessionEmail;
    if (!email) return null;
    return getCustomerByEmail(email);
}
function updateNavStars() {
    const customer = getCurrentUserCustomer();
    document.querySelectorAll('.aa-nav-stars').forEach(btn => {
        if (!customer) { btn.style.display = 'none'; return; }
        btn.style.display = 'flex';
        const count = customer.stars || 0;
        const gifts = getGiftsPending(customer);
        const countEl = btn.querySelector('.aa-nav-stars-count');
        if (countEl) countEl.textContent = count;
        const giftBadge = btn.querySelector('.aa-nav-gift-badge');
        if (giftBadge) {
            giftBadge.style.display = gifts > 0 ? 'flex' : 'none';
            if (gifts > 0) giftBadge.textContent = '🎁';
        }
        btn.classList.toggle('aa-has-gift', gifts > 0);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    aaUpdateBadge();
    updateNavStars();
    protectAllImages();
    const observer = new MutationObserver(protectAllImages);
    observer.observe(document.body, { childList: true, subtree: true });
});
