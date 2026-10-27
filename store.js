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

const cartStorageKey = 'coffee-cart';
const cart = new Map();
const cartPanel = document.querySelector('.cart-panel');
const cartBackdrop = document.querySelector('.cart-backdrop');
const checkoutDialog = document.querySelector('.checkout-dialog');
const checkoutForm = document.querySelector('.checkout-form');
const checkoutError = document.querySelector('.checkout-error');
const trackingForm = document.querySelector('.tracking-form');
const trackingMessage = document.querySelector('.tracking-message');
const trackingResult = document.querySelector('.tracking-result');
let currentTrackedOrder = null;

function normalizeEgyptianPhone(value) {
    const localized = value.trim()
        .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
        .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
    if (!/^\+?[\d\s().-]+$/.test(localized)) return null;
    let digits = localized.replace(/\D/g, '');
    if (digits.startsWith('0020')) digits = digits.slice(4);
    else if (digits.startsWith('20') && digits.length === 12) digits = digits.slice(2);
    else if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
    return /^1[0125]\d{8}$/.test(digits) ? `+20${digits}` : null;
}

function formatDate(value) {
    const locale = language() === 'ar' ? 'ar-EG' : 'en-EG';
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function showTrackingError(message) {
    trackingResult.hidden = true;
    trackingResult.replaceChildren();
    trackingMessage.textContent = message;
}

function renderTrackingOrder(order) {
    currentTrackedOrder = order;
    trackingMessage.textContent = '';
    trackingResult.replaceChildren();
    trackingResult.hidden = false;

    const heading = document.createElement('div');
    heading.className = 'tracking-result-heading';
    const title = document.createElement('h3');
    title.textContent = language() === 'ar' ? `الطلب ${order.id}` : `Order ${order.id}`;
    const status = document.createElement('span');
    status.className = `tracking-status status-${order.status}`;
    const statusLabels = {
        new: ['جديد', 'New'],
        confirmed: ['تم التأكيد', 'Confirmed'],
        preparing: ['قيد التجهيز', 'Preparing'],
        delivered: ['تم التسليم', 'Delivered'],
        cancelled: ['ملغي', 'Cancelled'],
    };
    status.textContent = (statusLabels[order.status] || [order.statusLabel, order.statusLabel])[language() === 'ar' ? 0 : 1];
    heading.append(title, status);

    const updated = document.createElement('p');
    const timestamp = order.updatedAt || order.createdAt;
    updated.className = 'tracking-updated';
    updated.textContent = language() === 'ar'
        ? `آخر تحديث: ${formatDate(timestamp)}`
        : `Last updated: ${formatDate(timestamp)}`;

    const items = document.createElement('ul');
    items.className = 'tracking-items';
    order.items.forEach((item) => {
        const row = document.createElement('li');
        const name = language() === 'ar' ? item.name : item.nameEn;
        row.textContent = `${name} × ${item.quantity}`;
        items.append(row);
    });

    const total = document.createElement('p');
    total.className = 'tracking-total';
    total.textContent = `${language() === 'ar' ? 'الإجمالي' : 'Total'}: ${money(order.total)}`;
    trackingResult.append(heading, updated, items, total);
}

async function trackOrder(orderId, phone) {
    const response = await fetch('/api/orders/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, phone }),
    });
    const result = await response.json();
    if (!response.ok) {
        const message = response.status === 404
            ? (language() === 'ar' ? 'لم نعثر على الطلب. تحقق من رقم الطلب والهاتف المستخدم عند الشراء.' : 'Order not found. Check the order number and phone number.')
            : response.status === 429
                ? (language() === 'ar' ? 'محاولات كثيرة. حاول مرة أخرى بعد 15 دقيقة.' : 'Too many attempts. Please try again in 15 minutes.')
                : result.error || 'Could not find this order.';
        throw new Error(message);
    }
    renderTrackingOrder(result.order);
}

trackingForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = trackingForm.querySelector('.tracking-submit');
    const formData = new FormData(trackingForm);
    const phone = normalizeEgyptianPhone(formData.get('phone'));
    const orderId = formData.get('orderId').trim();
    if (!phone) {
        showTrackingError(language() === 'ar'
            ? 'أدخل رقم موبايل مصري صحيحًا (010 أو 011 أو 012 أو 015).'
            : 'Enter a valid Egyptian mobile number (010, 011, 012, or 015).');
        return;
    }

    submitButton.disabled = true;
    trackingMessage.textContent = '';
    try {
        await trackOrder(orderId, phone);
    } catch (error) {
        showTrackingError(error.message);
    } finally {
        submitButton.disabled = false;
    }
});

document.querySelector('.cart-feedback').addEventListener('click', (event) => {
    const link = event.target.closest('[data-track-order]');
    if (!link) return;
    trackingForm.elements.orderId.value = link.dataset.trackOrder;
    trackingForm.elements.phone.value = '';
    setCartOpen(false);
});

document.querySelector('.lang').addEventListener('click', () => {
    if (currentTrackedOrder) renderTrackingOrder(currentTrackedOrder);
});

try {
    const savedCart = JSON.parse(localStorage.getItem(cartStorageKey) || '[]');
    savedCart.forEach(({ id, quantity }) => {
        if (products[id] && Number.isInteger(quantity) && quantity > 0 && quantity <= 30) cart.set(id, quantity);
    });
} catch {
    localStorage.removeItem(cartStorageKey);
}

function language() {
    return document.documentElement.lang === 'en' ? 'en' : 'ar';
}

function money(amount) {
    const locale = language() === 'ar' ? 'ar-EG' : 'en-EG';
    return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EGP', maximumFractionDigits: 0 }).format(amount);
}

function persistCart() {
    localStorage.setItem(cartStorageKey, JSON.stringify([...cart].map(([id, quantity]) => ({ id, quantity }))));
}

function renderCart() {
    const container = document.querySelector('.cart-items');
    const count = [...cart.values()].reduce((sum, quantity) => sum + quantity, 0);
    const total = [...cart].reduce((sum, [id, quantity]) => sum + products[id].price * quantity, 0);
    document.querySelector('.cart-count').textContent = count;
    document.querySelector('.cart-total').textContent = money(total);
    container.replaceChildren();

    if (!cart.size) {
        const empty = document.createElement('p');
        empty.className = 'cart-empty';
        empty.textContent = language() === 'ar' ? 'السلة فارغة حاليًا.' : 'Your cart is empty.';
        container.append(empty);
    }

    cart.forEach((quantity, id) => {
        const product = products[id];
        const row = document.createElement('div');
        row.className = 'cart-line';
        const details = document.createElement('div');
        const name = document.createElement('h3');
        name.textContent = product[language()];
        const price = document.createElement('p');
        price.textContent = money(product.price * quantity);
        details.append(name, price);

        const controls = document.createElement('div');
        controls.className = 'quantity-control';
        controls.innerHTML = `<button type="button" data-cart-action="decrease" data-id="${id}" aria-label="${language() === 'ar' ? 'تقليل الكمية' : 'Decrease quantity'}">−</button><span>${quantity}</span><button type="button" data-cart-action="increase" data-id="${id}" aria-label="${language() === 'ar' ? 'زيادة الكمية' : 'Increase quantity'}">+</button>`;
        const remove = document.createElement('button');
        remove.className = 'remove-item';
        remove.type = 'button';
        remove.dataset.cartAction = 'remove';
        remove.dataset.id = id;
        remove.textContent = language() === 'ar' ? 'حذف' : 'Remove';
        controls.append(remove);
        row.append(details, controls);
        container.append(row);
    });

    document.querySelector('.checkout-button').disabled = !cart.size;
    persistCart();
}

function setCartOpen(open) {
    cartPanel.classList.toggle('is-open', open);
    cartPanel.setAttribute('aria-hidden', String(!open));
    cartPanel.inert = !open;
    cartBackdrop.hidden = !open;
    document.body.classList.toggle('cart-open', open);
}

document.querySelectorAll('.add-to-cart').forEach((button) => {
    button.addEventListener('click', () => {
        const id = button.closest('[data-product-id]').dataset.productId;
        cart.set(id, Math.min(30, (cart.get(id) || 0) + 1));
        renderCart();
        setCartOpen(true);
    });
});

document.querySelector('.cart-trigger').addEventListener('click', () => setCartOpen(true));
document.querySelector('.close-cart').addEventListener('click', () => setCartOpen(false));
cartBackdrop.addEventListener('click', () => setCartOpen(false));
document.querySelector('.cart-items').addEventListener('click', (event) => {
    const button = event.target.closest('[data-cart-action]');
    if (!button) return;
    const { id, cartAction } = button.dataset;
    const quantity = cart.get(id) || 0;
    if (cartAction === 'remove' || (cartAction === 'decrease' && quantity <= 1)) cart.delete(id);
    else if (cartAction === 'decrease') cart.set(id, quantity - 1);
    else if (cartAction === 'increase') cart.set(id, Math.min(30, quantity + 1));
    renderCart();
});

document.querySelector('.checkout-button').addEventListener('click', () => {
    if (!cart.size) return;
    checkoutError.textContent = '';
    document.querySelector('.cart-feedback').textContent = '';
    setCartOpen(false);
    checkoutDialog.showModal();
});

document.querySelector('.close-checkout').addEventListener('click', () => checkoutDialog.close());

checkoutForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const languageCode = language();
    const submitButton = checkoutForm.querySelector('.checkout-submit');
    submitButton.disabled = true;
    checkoutError.textContent = '';

    try {
        const formData = new FormData(checkoutForm);
        const phone = normalizeEgyptianPhone(formData.get('phone'));
        if (!phone) {
            throw new Error(languageCode === 'ar'
                ? 'أدخل رقم موبايل مصري صحيحًا (010 أو 011 أو 012 أو 015).'
                : 'Enter a valid Egyptian mobile number (010, 011, 012, or 015).');
        }
        const response = await fetch('/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: formData.get('name'),
                phone,
                address: formData.get('address'),
                notes: formData.get('notes'),
                items: [...cart].map(([id, quantity]) => ({ id, quantity })),
            }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not save order');

        cart.clear();
        renderCart();
        checkoutForm.reset();
        checkoutDialog.close();
        const feedback = document.querySelector('.cart-feedback');
        feedback.replaceChildren(document.createTextNode(languageCode === 'ar'
            ? `تم استلام طلبك بنجاح. رقم الطلب: ${result.order.id} — `
            : `Your order was received. Order number: ${result.order.id} — `));
        const trackingLink = document.createElement('a');
        trackingLink.href = '#track-order';
        trackingLink.dataset.trackOrder = result.order.id;
        trackingLink.textContent = languageCode === 'ar' ? 'تتبع طلبك' : 'Track your order';
        feedback.append(trackingLink);
        setCartOpen(true);
    } catch (error) {
        checkoutError.textContent = languageCode === 'ar'
            ? `تعذر إرسال الطلب: ${error.message}. شغّل الموقع من خلال الخادم المحلي ثم أعد المحاولة.`
            : `Could not submit the order: ${error.message}. Run the site through its local server and try again.`;
    } finally {
        submitButton.disabled = false;
    }
});

renderCart();