const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const root = __dirname;
const dataDirectory = path.join(root, 'data');
const ordersFile = path.join(dataDirectory, 'orders.json');
const adminFile = path.join(dataDirectory, 'admin.json');
const products = {
    espresso: { ar: 'إسبريسو كلاسيك', en: 'Classic espresso', price: 89 },
    latte: { ar: 'لاتيه فاخر', en: 'Premium latte', price: 75 },
    arabica: { ar: 'حبوب عربية مختارة', en: 'Selected Arabica beans', price: 120 },
    'filter-coffee': { ar: 'قهوة فلتر يومية', en: 'Daily filter coffee', price: 65 },
    cappuccino: { ar: 'كابتشينو كريمي', en: 'Velvety cappuccino', price: 82 },
    mocha: { ar: 'موكا بالشوكولاتة', en: 'Chocolate mocha', price: 95 },
    'cold-brew': { ar: 'كولد برو منعش', en: 'Refreshing cold brew', price: 78 },
    'dark-roast': { ar: 'حبوب التحميص الداكن', en: 'Dark roast beans', price: 135 },
};
const orderStatuses = ['new', 'confirmed', 'preparing', 'delivered', 'cancelled'];
const statusLabels = {
    new: 'جديد',
    confirmed: 'تم التأكيد',
    preparing: 'قيد التجهيز',
    delivered: 'تم التسليم',
    cancelled: 'ملغي',
};
const sessions = new Map();
const trackingAttempts = new Map();
const scrypt = promisify(crypto.scrypt);
const pbkdf2 = promisify(crypto.pbkdf2);
let setupInProgress = false;
let dataQueue = Promise.resolve();

function loadEnvironment() {
    const envPath = path.join(root, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
        if (match && !Object.hasOwn(process.env, match[1])) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
}

loadEnvironment();

function sendJson(response, statusCode, value) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    response.end(JSON.stringify(value));
}

function readJsonFile(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return fallback;
        throw error;
    }
}

function serialized(operation) {
    const result = dataQueue.then(operation, operation);
    dataQueue = result.catch(() => { });
    return result;
}

async function writeJsonFile(filePath, value) {
    await fs.promises.mkdir(dataDirectory, { recursive: true });
    const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.promises.rename(temporaryPath, filePath);
}

async function readRequestBody(request) {
    let body = '';
    for await (const chunk of request) {
        body += chunk;
        if (body.length > 100_000) throw Object.assign(new Error('Request is too large'), { statusCode: 413 });
    }
    try {
        const parsed = JSON.parse(body || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Request body must be a JSON object.');
        }
        return parsed;
    } catch {
        throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
    }
}

function cleanText(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeEgyptianPhone(value) {
    if (typeof value !== 'string') return null;
    const localized = value.replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
        .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
    if (!/^\+?[\d\s().-]+$/.test(localized)) return null;
    let digits = localized.replace(/\D/g, '');
    if (digits.startsWith('0020')) digits = digits.slice(4);
    else if (digits.startsWith('20') && digits.length === 12) digits = digits.slice(2);
    else if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
    return /^1[0125]\d{8}$/.test(digits) ? `+20${digits}` : null;
}

function allowTrackingAttempt(request) {
    const now = Date.now();
    const key = request.socket.remoteAddress || 'unknown';
    let attempt = trackingAttempts.get(key);
    if (!attempt || now - attempt.startedAt >= 15 * 60 * 1000) {
        attempt = { startedAt: now, count: 0 };
        trackingAttempts.set(key, attempt);
    }
    attempt.count += 1;
    if (trackingAttempts.size > 1000) {
        for (const [address, entry] of trackingAttempts) {
            if (now - entry.startedAt >= 15 * 60 * 1000) trackingAttempts.delete(address);
        }
    }
    return attempt.count <= 10;
}

function configuredAdmin() {
    return fs.existsSync(adminFile);
}

function createSession(username) {
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { username, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    return token;
}

function authenticated(request) {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    const session = token && sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
        if (token) sessions.delete(token);
        return false;
    }
    return session;
}

async function handleApi(request, response, url) {
    if (request.method === 'POST' && url.pathname === '/api/orders') {
        const body = await readRequestBody(request);
        const name = cleanText(body.name, 100);
        const phone = normalizeEgyptianPhone(body.phone);
        const address = cleanText(body.address, 500);
        const notes = cleanText(body.notes, 500);
        if (name.length < 2 || !phone || address.length < 5) {
            return sendJson(response, 400, { error: 'Please provide a valid name, Egyptian mobile number, and address.' });
        }
        if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) {
            return sendJson(response, 400, { error: 'The order must contain between 1 and 20 products.' });
        }

        const quantities = new Map();
        for (const item of body.items) {
            if (!products[item.id] || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 30) {
                return sendJson(response, 400, { error: 'The order contains an invalid product or quantity.' });
            }
            quantities.set(item.id, Math.min(30, (quantities.get(item.id) || 0) + item.quantity));
        }

        const items = [...quantities].map(([id, quantity]) => ({
            id,
            name: products[id].ar,
            nameEn: products[id].en,
            price: products[id].price,
            quantity,
        }));
        const order = {
            id: `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
            createdAt: new Date().toISOString(),
            status: 'new',
            statusLabel: statusLabels.new,
            customer: { name, phone, address, notes },
            items,
            total: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
        };

        await serialized(async () => {
            const orders = readJsonFile(ordersFile, []);
            orders.unshift(order);
            await writeJsonFile(ordersFile, orders);
        });
        return sendJson(response, 201, { order });
    }

    if (request.method === 'POST' && url.pathname === '/api/orders/track') {
        if (!allowTrackingAttempt(request)) {
            return sendJson(response, 429, { error: 'Too many tracking attempts. Please try again in 15 minutes.' });
        }
        const body = await readRequestBody(request);
        const orderId = cleanText(body.orderId, 40);
        const phone = normalizeEgyptianPhone(body.phone);
        if (!orderId || !phone) return sendJson(response, 404, { error: 'Order not found. Check the order number and phone number.' });

        const order = readJsonFile(ordersFile, []).find((entry) =>
            entry.id === orderId && normalizeEgyptianPhone(entry.customer.phone) === phone);
        if (!order) return sendJson(response, 404, { error: 'Order not found. Check the order number and phone number.' });
        return sendJson(response, 200, {
            order: {
                id: order.id,
                createdAt: order.createdAt,
                updatedAt: order.updatedAt || null,
                status: order.status,
                statusLabel: statusLabels[order.status],
                items: order.items.map(({ name, nameEn, quantity }) => ({ name, nameEn, quantity })),
                total: order.total,
            },
        });
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/status') {
        return sendJson(response, 200, { configured: configuredAdmin() });
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/setup') {
        if (configuredAdmin() || setupInProgress) return sendJson(response, 409, { error: 'Admin account is already configured.' });
        setupInProgress = true;
        try {
            const body = await readRequestBody(request);
            const username = cleanText(body.username, 40);
            const password = typeof body.password === 'string' ? body.password : '';
            if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username) || password.length < 12) {
                return sendJson(response, 400, { error: 'Use a username of 3-40 letters or numbers and a password of at least 12 characters.' });
            }
            const salt = crypto.randomBytes(16).toString('hex');
            const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
            await writeJsonFile(adminFile, { username, salt, passwordHash, createdAt: new Date().toISOString() });
            const token = createSession(username);
            return sendJson(response, 201, { token, username });
        } finally {
            setupInProgress = false;
        }
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/login') {
        const body = await readRequestBody(request);
        const admin = readJsonFile(adminFile, null);
        if (!admin) return sendJson(response, 404, { error: 'Create the admin account first.' });
        const username = cleanText(body.username, 40);
        const password = typeof body.password === 'string' ? body.password : '';
        const expected = Buffer.from(admin.passwordHash, 'hex');
        const candidate = admin.algorithm === 'pbkdf2-sha256'
            ? await pbkdf2(password, Buffer.from(admin.salt, 'hex'), admin.iterations, expected.length, 'sha256')
            : await scrypt(password, admin.salt, 64);
        if (username !== admin.username || candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
            return sendJson(response, 401, { error: 'Incorrect username or password.' });
        }
        return sendJson(response, 200, { token: createSession(username), username });
    }

    const session = authenticated(request);
    if (!session) return sendJson(response, 401, { error: 'Please sign in again.' });

    if (request.method === 'GET' && url.pathname === '/api/admin/orders') {
        return sendJson(response, 200, { orders: readJsonFile(ordersFile, []) });
    }

    const statusMatch = url.pathname.match(/^\/api\/admin\/orders\/([A-Z0-9-]+)$/i);
    if (request.method === 'PATCH' && statusMatch) {
        const body = await readRequestBody(request);
        if (!orderStatuses.includes(body.status)) return sendJson(response, 400, { error: 'Invalid order status.' });
        const updated = await serialized(async () => {
            const orders = readJsonFile(ordersFile, []);
            const order = orders.find((entry) => entry.id === statusMatch[1]);
            if (!order) return null;
            order.status = body.status;
            order.statusLabel = statusLabels[body.status];
            order.updatedAt = new Date().toISOString();
            await writeJsonFile(ordersFile, orders);
            return order;
        });
        return updated
            ? sendJson(response, 200, { order: updated })
            : sendJson(response, 404, { error: 'Order not found.' });
    }

    return sendJson(response, 404, { error: 'Not found.' });
}

const publicFiles = new Map([
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/store.js', ['store.js', 'text/javascript; charset=utf-8']],
    ['/admin.html', ['admin.html', 'text/html; charset=utf-8']],
    ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
]);

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
        if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
        if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'Method not allowed.' });
        const file = publicFiles.get(url.pathname === '/' ? '/index.html' : url.pathname);
        if (!file) return sendJson(response, 404, { error: 'Not found.' });
        const content = await fs.promises.readFile(path.join(root, file[0]));
        response.writeHead(200, {
            'Content-Type': file[1],
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'same-origin',
            'Content-Security-Policy': "default-src 'self' https://images.unsplash.com https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' https://images.unsplash.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'self'; form-action 'self'",
        });
        response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
        const statusCode = error.statusCode || 500;
        sendJson(response, statusCode, { error: statusCode === 500 ? 'An unexpected server error occurred.' : error.message });
        if (statusCode === 500) console.error(error);
    }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, '127.0.0.1', () => {
    console.log(`Coffee store running at http://localhost:${port}`);
});