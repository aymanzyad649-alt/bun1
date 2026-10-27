const tokenKey = 'coffee-admin-token';
const authPanel = document.querySelector('#auth-panel');
const authForm = document.querySelector('#auth-form');
const dashboard = document.querySelector('#dashboard');
const authMessage = document.querySelector('#auth-message');
const dashboardMessage = document.querySelector('#dashboard-message');
let isSetup = false;
let allOrders = [];

async function api(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    const token = localStorage.getItem(tokenKey);
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(path, { ...options, headers });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر إكمال العملية.');
    return result;
}

function showAuth(message = '') {
    dashboard.classList.add('admin-hidden');
    authPanel.classList.remove('admin-hidden');
    authMessage.textContent = message;
    document.querySelector('#auth-title').textContent = isSetup ? 'إعداد حساب الإدارة' : 'دخول المسؤول';
    document.querySelector('#auth-description').textContent = isSetup
        ? 'أنشئ حساب المسؤول الأول. كلمة المرور يجب أن تحتوي على 12 حرفًا على الأقل.'
        : 'سجل الدخول لمتابعة طلبات المتجر وتحديث حالتها.';
    document.querySelector('#auth-submit').textContent = isSetup ? 'إنشاء الحساب' : 'تسجيل الدخول';
    authForm.elements.password.autocomplete = isSetup ? 'new-password' : 'current-password';
    authForm.elements.password.minLength = isSetup ? 12 : 1;
}

function formatDate(value) {
    return new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function makeCell(text, className = '') {
    const cell = document.createElement('td');
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
}

function renderOrders() {
    const body = document.querySelector('#orders-body');
    body.replaceChildren();
    const selectedStatus = document.querySelector('#status-filter').value;
    const visibleOrders = selectedStatus === 'all'
        ? allOrders
        : allOrders.filter((order) => order.status === selectedStatus);

    if (!visibleOrders.length) {
        const row = document.createElement('tr');
        const empty = makeCell('لا توجد طلبات لعرضها.', 'admin-empty');
        empty.colSpan = 5;
        row.append(empty);
        body.append(row);
        return;
    }

    visibleOrders.forEach((order) => {
        const row = document.createElement('tr');
        const orderCell = document.createElement('td');
        orderCell.append(document.createTextNode(order.id));
        const date = document.createElement('div');
        date.textContent = formatDate(order.createdAt);
        date.style.fontWeight = '400';
        date.style.color = '#6d706c';
        orderCell.append(date);

        const customerCell = document.createElement('td');
        const customerName = document.createElement('strong');
        customerName.textContent = order.customer.name;
        const customerPhone = document.createElement('div');
        customerPhone.textContent = order.customer.phone;
        const customerAddress = document.createElement('div');
        customerAddress.textContent = order.customer.address;
        customerCell.append(customerName, customerPhone, customerAddress);
        if (order.customer.notes) {
            const notes = document.createElement('small');
            notes.textContent = `ملاحظات: ${order.customer.notes}`;
            customerCell.append(notes);
        }

        const itemList = document.createElement('div');
        itemList.className = 'admin-order-items';
        itemList.textContent = order.items.map((item) => `${item.name} × ${item.quantity}`).join('، ');
        const total = new Intl.NumberFormat('ar-EG', { style: 'currency', currency: 'EGP', maximumFractionDigits: 0 }).format(order.total);

        const statusCell = document.createElement('td');
        const status = document.createElement('select');
        status.setAttribute('aria-label', `حالة الطلب ${order.id}`);
        const statuses = [
            ['new', 'جديد'], ['confirmed', 'تم التأكيد'], ['preparing', 'قيد التجهيز'],
            ['delivered', 'تم التسليم'], ['cancelled', 'ملغي'],
        ];
        statuses.forEach(([value, label]) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            option.selected = order.status === value;
            status.append(option);
        });
        status.addEventListener('change', async () => {
            status.disabled = true;
            try {
                await api(`/api/admin/orders/${encodeURIComponent(order.id)}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: status.value }),
                });
                await loadOrders();
            } catch (error) {
                dashboardMessage.textContent = error.message;
                status.disabled = false;
            }
        });
        statusCell.append(status);
        row.append(orderCell, customerCell, makeCell(itemList.textContent, 'admin-order-items'), makeCell(total), statusCell);
        body.append(row);
    });
}

async function loadOrders() {
    const result = await api('/api/admin/orders');
    allOrders = result.orders;
    renderOrders();
    dashboardMessage.textContent = '';
    document.querySelector('#last-updated').textContent = `آخر تحديث: ${formatDate(new Date().toISOString())}`;
}

function showDashboard() {
    authPanel.classList.add('admin-hidden');
    dashboard.classList.remove('admin-hidden');
}

authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    authMessage.textContent = '';
    const submit = document.querySelector('#auth-submit');
    submit.disabled = true;
    const formData = new FormData(authForm);
    try {
        const result = await api(isSetup ? '/api/admin/setup' : '/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({ username: formData.get('username'), password: formData.get('password') }),
        });
        localStorage.setItem(tokenKey, result.token);
        showDashboard();
        await loadOrders();
    } catch (error) {
        authMessage.textContent = error.message;
    } finally {
        submit.disabled = false;
    }
});

document.querySelector('#refresh-orders').addEventListener('click', async () => {
    try {
        await loadOrders();
    } catch (error) {
        dashboardMessage.textContent = error.message;
    }
});

document.querySelector('#status-filter').addEventListener('change', renderOrders);
document.querySelector('#logout').addEventListener('click', () => {
    localStorage.removeItem(tokenKey);
    showAuth();
});

async function initialize() {
    try {
        const state = await api('/api/admin/status');
        isSetup = !state.configured;
        const token = localStorage.getItem(tokenKey);
        if (token && !isSetup) {
            showDashboard();
            await loadOrders();
            return;
        }
        showAuth();
    } catch (error) {
        showAuth(error.message);
    }
}

initialize();
window.setInterval(() => {
    if (!dashboard.classList.contains('admin-hidden')) {
        loadOrders().catch((error) => { dashboardMessage.textContent = error.message; });
    }
}, 30000);