const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3000';
const ordersFile = path.join(__dirname, 'data', 'orders.json');

async function check(path, expectedStatus) {
    const response = await fetch(new URL(path, baseUrl));
    if (response.status !== expectedStatus) {
        throw new Error(`${path}: expected ${expectedStatus}, received ${response.status}`);
    }
    return response;
}

async function main() {
    const home = await check('/', 200);
    const homeHtml = await home.text();
    if (!homeHtml.includes('store.js') || !homeHtml.includes('tracking-form')) {
        throw new Error('Storefront script or customer order tracking is missing from the home page.');
    }
    await check('/admin.html', 200);

    const adminStatus = await check('/api/admin/status', 200);
    if (!(await adminStatus.json()).configured) throw new Error('Admin account is not configured.');
    await check('/api/admin/orders', 401);
    const invalidOrder = await fetch(new URL('/api/orders', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [] }),
    });
    if (invalidOrder.status !== 400) throw new Error(`Invalid order should be rejected, received ${invalidOrder.status}.`);
    const invalidPhoneOrder = await fetch(new URL('/api/orders', baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Invalid phone test',
            phone: '12345',
            address: 'Local smoke test address',
            items: [{ id: 'latte', quantity: 1 }],
        }),
    });
    if (invalidPhoneOrder.status !== 400) throw new Error(`Invalid phone should be rejected, received ${invalidPhoneOrder.status}.`);

    const testName = `Local smoke test ${crypto.randomUUID()}`;
    let testOrderId;
    try {
        const orderResponse = await fetch(new URL('/api/orders', baseUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: testName,
                phone: '٠١٠١٢٣٤٥٦٧٨',
                address: 'Local smoke test address',
                items: [
                    { id: 'cappuccino', quantity: 1 },
                    { id: 'mocha', quantity: 1 },
                    { id: 'cold-brew', quantity: 1 },
                    { id: 'dark-roast', quantity: 1 },
                ],
            }),
        });
        const result = await orderResponse.json();
        if (orderResponse.status !== 201) throw new Error(`Valid order should be accepted, received ${orderResponse.status}.`);
        if (result.order.total !== 390 || result.order.customer.name !== testName || result.order.items.length !== 4) {
            throw new Error('The saved order does not contain the expected customer or total.');
        }
        testOrderId = result.order.id;
        const trackingResponse = await fetch(new URL('/api/orders/track', baseUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: testOrderId, phone: '+20 1012345678' }),
        });
        const trackingResult = await trackingResponse.json();
        if (trackingResponse.status !== 200 || trackingResult.order.status !== 'new'
            || trackingResult.order.total !== 390 || trackingResult.order.items.length !== 4) {
            throw new Error('Customer tracking does not return the expected order status and summary.');
        }
        if ('customer' in trackingResult.order || 'address' in trackingResult.order) {
            throw new Error('Customer tracking exposed private order details.');
        }

        const wrongPhoneResponse = await fetch(new URL('/api/orders/track', baseUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: testOrderId, phone: '+201112345678' }),
        });
        if (wrongPhoneResponse.status !== 404) throw new Error('Tracking should reject a phone number that does not match the order.');

        const savedOrders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
        if (!savedOrders.some((order) => order.id === testOrderId)) throw new Error('The order was not persisted locally.');
        console.log(`Order submission passed and was saved locally (${testOrderId}).`);
    } finally {
        if (testOrderId && fs.existsSync(ordersFile)) {
            const savedOrders = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
            const remainingOrders = savedOrders.filter((order) => order.id !== testOrderId);
            if (remainingOrders.length) fs.writeFileSync(ordersFile, JSON.stringify(remainingOrders, null, 2));
            else fs.unlinkSync(ordersFile);
        }
    }

    console.log('Smoke tests passed: storefront, admin page, authorization, phone validation, private order tracking, and local order persistence.');
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});