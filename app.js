/* ========================================
   PropertyPulse — Follow-Up Tracker
   Application Logic
   ======================================== */

// ========== Constants ==========
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = { sunday: 'Sunday', monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday' };
const TYPE_ICONS = { call: '📞', meeting: '🤝', 'site-visit': '🏗️', document: '📄', payment: '💰' };
const TYPE_LABELS = { call: 'Call', meeting: 'Meeting', 'site-visit': 'Site Visit', document: 'Document', payment: 'Payment' };
const STORAGE_KEY = 'propertypulse_followups';
const NOTIF_KEY = 'propertypulse_notifications';

// ========== State ==========
let followups = [];
let activeFilter = 'all';
let searchQuery = '';

// ========== DOM Elements ==========
const followupForm = document.getElementById('followup-form');
const followupList = document.getElementById('followup-list');
const emptyState = document.getElementById('empty-state');
const searchInput = document.getElementById('search-input');
const notificationBtn = document.getElementById('notification-btn');
const reminderBanner = document.getElementById('reminder-banner');
const reminderText = document.getElementById('reminder-text');
const reminderDismiss = document.getElementById('reminder-dismiss');
const editModal = document.getElementById('edit-modal');
const editForm = document.getElementById('edit-form');
const modalClose = document.getElementById('modal-close');
const modalCancel = document.getElementById('modal-cancel');
const currentDateEl = document.getElementById('current-date');

// ========== Initialize ==========
document.addEventListener('DOMContentLoaded', () => {
    loadFollowups();
    renderFollowups();
    updateStats();
    updateDateDisplay();
    checkReminders();
    setupEventListeners();
    setupNotificationButton();

    // Set min date for date picker to today
    const today = getLocalDateString(new Date());
    document.getElementById('followup-date').min = today;

    // Check reminders every 30 minutes
    setInterval(checkReminders, 30 * 60 * 1000);
});

// ========== Date Helpers ==========
function getLocalDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getToday() {
    return new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
}

function getTomorrow() {
    const tomorrow = getToday();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
}

function getNextDayOfWeek(dayName) {
    const today = getToday();
    const todayIndex = today.getDay();
    const targetIndex = DAYS.indexOf(dayName);
    let daysUntil = targetIndex - todayIndex;
    if (daysUntil <= 0) daysUntil += 7;
    const nextDate = new Date(today);
    nextDate.setDate(today.getDate() + daysUntil);
    return nextDate;
}

function getEndOfWeek() {
    const today = getToday();
    const daysUntilSunday = 7 - today.getDay();
    const endOfWeek = new Date(today);
    endOfWeek.setDate(today.getDate() + daysUntilSunday);
    return endOfWeek;
}

function formatDate(dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    const today = getToday();
    const tomorrow = getTomorrow();

    if (date.getTime() === today.getTime()) return 'Today';
    if (date.getTime() === tomorrow.getTime()) return 'Tomorrow';

    const options = { weekday: 'short', day: 'numeric', month: 'short' };
    return date.toLocaleDateString('en-IN', options);
}

function getDateStatus(dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    const today = getToday();
    const tomorrow = getTomorrow();

    if (date.getTime() < today.getTime()) return 'overdue';
    if (date.getTime() === today.getTime()) return 'today';
    if (date.getTime() === tomorrow.getTime()) return 'tomorrow';
    return 'upcoming';
}

function updateDateDisplay() {
    const options = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
    currentDateEl.textContent = new Date().toLocaleDateString('en-IN', options);
}

// ========== Storage ==========
function loadFollowups() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        followups = stored ? JSON.parse(stored) : [];
    } catch (e) {
        followups = [];
    }
}

function saveFollowups() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(followups));
}

// ========== Event Listeners ==========
function setupEventListeners() {
    // Form submit
    followupForm.addEventListener('submit', handleFormSubmit);

    // Search
    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase();
        renderFollowups();
    });

    // Filter tabs
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeFilter = tab.dataset.filter;
            renderFollowups();
        });
    });

    // Reminder dismiss
    reminderDismiss.addEventListener('click', () => {
        reminderBanner.classList.add('hidden');
    });

    // Modal
    modalClose.addEventListener('click', closeModal);
    modalCancel.addEventListener('click', closeModal);
    editModal.addEventListener('click', (e) => {
        if (e.target === editModal) closeModal();
    });
    editForm.addEventListener('submit', handleEditSubmit);

    // Close modal on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !editModal.classList.contains('hidden')) {
            closeModal();
        }
    });

    // Day/date toggle: if date is picked, clear day and vice versa
    document.getElementById('followup-schedule').addEventListener('change', function () {
        if (this.value) document.getElementById('followup-date').value = '';
    });
    document.getElementById('followup-date').addEventListener('change', function () {
        if (this.value) document.getElementById('followup-schedule').value = '';
    });
    document.getElementById('edit-followup-schedule').addEventListener('change', function () {
        if (this.value) document.getElementById('edit-followup-date').value = '';
    });
    document.getElementById('edit-followup-date').addEventListener('change', function () {
        if (this.value) document.getElementById('edit-followup-schedule').value = '';
    });
}

// ========== Form Handling ==========
function handleFormSubmit(e) {
    e.preventDefault();

    const name = document.getElementById('client-name').value.trim();
    const phone = document.getElementById('client-phone').value.trim();
    const property = document.getElementById('property-detail').value.trim();
    const type = document.getElementById('followup-type').value;
    const priority = document.getElementById('priority').value;
    const scheduledDay = document.getElementById('followup-schedule').value;
    const scheduledDate = document.getElementById('followup-date').value;
    const notes = document.getElementById('notes').value.trim();

    if (!name) {
        showToast('Please enter client name', 'error');
        return;
    }

    if (!scheduledDay && !scheduledDate) {
        showToast('Please select a follow-up day or date', 'error');
        return;
    }

    // Calculate the actual follow-up date
    let followupDate;
    let recurringDay = null;

    if (scheduledDate) {
        followupDate = scheduledDate;
    } else {
        recurringDay = scheduledDay;
        const nextDate = getNextDayOfWeek(scheduledDay);
        followupDate = getLocalDateString(nextDate);
    }

    const followup = {
        id: Date.now().toString(),
        name,
        phone,
        property,
        type,
        priority,
        followupDate,
        recurringDay,
        notes,
        completed: false,
        createdAt: new Date().toISOString()
    };

    followups.push(followup);
    saveFollowups();
    renderFollowups();
    updateStats();
    checkReminders();

    // Reset form
    followupForm.reset();

    showToast(`Follow-up added for ${name}`, 'success');
}

// ========== Render Follow-ups ==========
function renderFollowups() {
    const filtered = getFilteredFollowups();
    followupList.innerHTML = '';

    if (filtered.length === 0) {
        followupList.style.display = 'none';
        emptyState.classList.remove('hidden');
        emptyState.querySelector('h3').textContent =
            activeFilter === 'all' && !searchQuery ? 'No follow-ups yet' : 'No matching follow-ups';
        emptyState.querySelector('p').textContent =
            activeFilter === 'all' && !searchQuery
                ? 'Add your first client follow-up to get started!'
                : 'Try a different filter or search term.';
        return;
    }

    followupList.style.display = 'flex';
    emptyState.classList.add('hidden');

    // Sort: overdue first, then today, then tomorrow, then upcoming. Completed last.
    filtered.sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        const dateA = new Date(a.followupDate + 'T00:00:00');
        const dateB = new Date(b.followupDate + 'T00:00:00');
        if (dateA.getTime() !== dateB.getTime()) return dateA - dateB;
        return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    filtered.forEach(item => {
        const el = createFollowupElement(item);
        followupList.appendChild(el);
    });
}

function getFilteredFollowups() {
    let filtered = [...followups];
    const today = getToday();
    const tomorrow = getTomorrow();
    const endOfWeek = getEndOfWeek();

    // Filter by tab
    switch (activeFilter) {
        case 'today':
            filtered = filtered.filter(f => {
                const d = new Date(f.followupDate + 'T00:00:00');
                return d.getTime() === today.getTime() && !f.completed;
            });
            break;
        case 'tomorrow':
            filtered = filtered.filter(f => {
                const d = new Date(f.followupDate + 'T00:00:00');
                return d.getTime() === tomorrow.getTime() && !f.completed;
            });
            break;
        case 'this-week':
            filtered = filtered.filter(f => {
                const d = new Date(f.followupDate + 'T00:00:00');
                return d >= today && d <= endOfWeek && !f.completed;
            });
            break;
        case 'overdue':
            filtered = filtered.filter(f => {
                const d = new Date(f.followupDate + 'T00:00:00');
                return d < today && !f.completed;
            });
            break;
    }

    // Filter by search
    if (searchQuery) {
        filtered = filtered.filter(f =>
            f.name.toLowerCase().includes(searchQuery) ||
            (f.phone && f.phone.includes(searchQuery)) ||
            (f.property && f.property.toLowerCase().includes(searchQuery))
        );
    }

    return filtered;
}

function createFollowupElement(item) {
    const div = document.createElement('div');
    const status = item.completed ? 'completed' : getDateStatus(item.followupDate);
    div.className = `followup-item ${status}`;
    div.setAttribute('data-id', item.id);

    const typeIcon = TYPE_ICONS[item.type] || '📋';
    const typeLabel = TYPE_LABELS[item.type] || item.type;
    const dateLabel = formatDate(item.followupDate);
    const statusLabel = item.completed ? 'Completed' : status.charAt(0).toUpperCase() + status.slice(1);

    // Phone actions
    let phoneHTML = '';
    if (item.phone) {
        phoneHTML = `
            <div class="item-detail">
                <span class="item-detail-icon">📱</span>
                <span>${item.phone}</span>
            </div>`;
    }

    // Property
    let propertyHTML = '';
    if (item.property) {
        propertyHTML = `
            <div class="item-detail">
                <span class="item-detail-icon">🏠</span>
                <span>${item.property}</span>
            </div>`;
    }

    // Recurring badge
    let recurringHTML = '';
    if (item.recurringDay) {
        recurringHTML = `
            <div class="item-detail">
                <span class="item-detail-icon">🔁</span>
                <span>Every ${DAY_LABELS[item.recurringDay]}</span>
            </div>`;
    }

    // Notes
    let notesHTML = '';
    if (item.notes) {
        notesHTML = `<div class="item-notes">📝 ${escapeHtml(item.notes)}</div>`;
    }

    // Phone buttons
    let phoneActionsHTML = '';
    if (item.phone) {
        phoneActionsHTML = `
            <a href="tel:${item.phone}" class="btn btn-sm btn-call" title="Call">📞</a>
            <a href="https://wa.me/91${item.phone}" target="_blank" rel="noopener" class="btn btn-sm btn-whatsapp" title="WhatsApp">💬</a>`;
    }

    div.innerHTML = `
        <div class="item-top">
            <span class="item-name">${escapeHtml(item.name)}</span>
            <span class="item-priority ${item.priority}">${item.priority}</span>
        </div>
        <div class="item-details">
            <div class="item-detail">
                <span class="item-detail-icon">${typeIcon}</span>
                <span>${typeLabel}</span>
            </div>
            ${phoneHTML}
            ${propertyHTML}
            ${recurringHTML}
        </div>
        ${notesHTML}
        <div class="item-bottom">
            <span class="item-date-badge ${status}">${dateLabel} ${item.completed ? '✅' : ''}</span>
            <div class="item-actions">
                ${phoneActionsHTML}
                ${!item.completed ? `<button class="btn btn-sm btn-done" onclick="markDone('${item.id}')" title="Mark as done">✓</button>` : `<button class="btn btn-sm btn-done" onclick="markUndone('${item.id}')" title="Reopen">↩️</button>`}
                <button class="btn btn-sm btn-edit" onclick="openEdit('${item.id}')" title="Edit">✏️</button>
                <button class="btn btn-sm btn-delete" onclick="deleteFollowup('${item.id}')" title="Delete">🗑️</button>
            </div>
        </div>
    `;

    return div;
}

// ========== Actions ==========
function markDone(id) {
    const item = followups.find(f => f.id === id);
    if (!item) return;

    item.completed = true;
    item.completedAt = new Date().toISOString();

    // If recurring, create next follow-up
    if (item.recurringDay) {
        const nextDate = getNextDayOfWeek(item.recurringDay);
        const newFollowup = {
            ...item,
            id: Date.now().toString(),
            followupDate: getLocalDateString(nextDate),
            completed: false,
            completedAt: null,
            createdAt: new Date().toISOString()
        };
        followups.push(newFollowup);
        showToast(`Done! Next follow-up auto-scheduled for ${DAY_LABELS[item.recurringDay]}`, 'success');
    } else {
        showToast(`${item.name} marked as done!`, 'success');
    }

    saveFollowups();
    renderFollowups();
    updateStats();
}

function markUndone(id) {
    const item = followups.find(f => f.id === id);
    if (!item) return;

    item.completed = false;
    item.completedAt = null;

    saveFollowups();
    renderFollowups();
    updateStats();
    showToast(`${item.name} reopened`, 'info');
}

function deleteFollowup(id) {
    const item = followups.find(f => f.id === id);
    if (!item) return;

    if (!confirm(`Delete follow-up for "${item.name}"?`)) return;

    followups = followups.filter(f => f.id !== id);
    saveFollowups();
    renderFollowups();
    updateStats();
    showToast('Follow-up deleted', 'warning');
}

// ========== Edit Modal ==========
function openEdit(id) {
    const item = followups.find(f => f.id === id);
    if (!item) return;

    document.getElementById('edit-id').value = item.id;
    document.getElementById('edit-client-name').value = item.name;
    document.getElementById('edit-client-phone').value = item.phone || '';
    document.getElementById('edit-property-detail').value = item.property || '';
    document.getElementById('edit-followup-type').value = item.type;
    document.getElementById('edit-priority').value = item.priority;
    document.getElementById('edit-followup-schedule').value = item.recurringDay || '';
    document.getElementById('edit-followup-date').value = item.recurringDay ? '' : item.followupDate;
    document.getElementById('edit-notes').value = item.notes || '';

    editModal.classList.remove('hidden');
    document.getElementById('edit-client-name').focus();
}

function closeModal() {
    editModal.classList.add('hidden');
}

function handleEditSubmit(e) {
    e.preventDefault();

    const id = document.getElementById('edit-id').value;
    const item = followups.find(f => f.id === id);
    if (!item) return;

    const scheduledDay = document.getElementById('edit-followup-schedule').value;
    const scheduledDate = document.getElementById('edit-followup-date').value;

    if (!scheduledDay && !scheduledDate) {
        showToast('Please select a follow-up day or date', 'error');
        return;
    }

    item.name = document.getElementById('edit-client-name').value.trim();
    item.phone = document.getElementById('edit-client-phone').value.trim();
    item.property = document.getElementById('edit-property-detail').value.trim();
    item.type = document.getElementById('edit-followup-type').value;
    item.priority = document.getElementById('edit-priority').value;
    item.notes = document.getElementById('edit-notes').value.trim();

    if (scheduledDate) {
        item.followupDate = scheduledDate;
        item.recurringDay = null;
    } else {
        item.recurringDay = scheduledDay;
        item.followupDate = getLocalDateString(getNextDayOfWeek(scheduledDay));
    }

    saveFollowups();
    renderFollowups();
    updateStats();
    closeModal();
    showToast(`${item.name} updated!`, 'success');
}

// ========== Stats ==========
function updateStats() {
    const today = getToday();
    const tomorrow = getTomorrow();
    const active = followups.filter(f => !f.completed);

    const todayCount = active.filter(f => new Date(f.followupDate + 'T00:00:00').getTime() === today.getTime()).length;
    const tomorrowCount = active.filter(f => new Date(f.followupDate + 'T00:00:00').getTime() === tomorrow.getTime()).length;
    const overdueCount = active.filter(f => new Date(f.followupDate + 'T00:00:00') < today).length;

    animateNumber('stat-total', followups.length);
    animateNumber('stat-today', todayCount);
    animateNumber('stat-tomorrow', tomorrowCount);
    animateNumber('stat-overdue', overdueCount);
}

function animateNumber(elementId, target) {
    const el = document.getElementById(elementId);
    const current = parseInt(el.textContent) || 0;
    if (current === target) return;

    const duration = 400;
    const steps = 15;
    const stepTime = duration / steps;
    const increment = (target - current) / steps;
    let step = 0;

    const timer = setInterval(() => {
        step++;
        el.textContent = Math.round(current + increment * step);
        if (step >= steps) {
            el.textContent = target;
            clearInterval(timer);
        }
    }, stepTime);
}

// ========== Notifications ==========
function setupNotificationButton() {
    notificationBtn.addEventListener('click', async () => {
        if (!('Notification' in window)) {
            showToast('Your browser does not support notifications', 'error');
            return;
        }

        if (Notification.permission === 'granted') {
            showToast('Notifications are already enabled!', 'info');
            notificationBtn.querySelector('span').textContent = '🔔';
            notificationBtn.classList.add('active');
            return;
        }

        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            localStorage.setItem(NOTIF_KEY, 'true');
            notificationBtn.querySelector('span').textContent = '🔔';
            notificationBtn.classList.add('active');
            showToast('Notifications enabled! You\'ll get reminders 🔔', 'success');
            checkReminders();
        } else {
            showToast('Notifications blocked. Enable in browser settings.', 'warning');
        }
    });

    // Update button state on load
    if (Notification.permission === 'granted') {
        notificationBtn.querySelector('span').textContent = '🔔';
        notificationBtn.classList.add('active');
    }
}

function checkReminders() {
    const today = getToday();
    const tomorrow = getTomorrow();
    const active = followups.filter(f => !f.completed);

    // Check for today's follow-ups
    const todayFollowups = active.filter(f => new Date(f.followupDate + 'T00:00:00').getTime() === today.getTime());

    // Check for tomorrow's follow-ups (1 day prior reminder)
    const tomorrowFollowups = active.filter(f => new Date(f.followupDate + 'T00:00:00').getTime() === tomorrow.getTime());

    // Check overdue
    const overdueFollowups = active.filter(f => new Date(f.followupDate + 'T00:00:00') < today);

    // Show banner
    if (todayFollowups.length > 0 || overdueFollowups.length > 0) {
        let message = '';
        if (overdueFollowups.length > 0) {
            message += `⚠️ ${overdueFollowups.length} overdue! `;
        }
        if (todayFollowups.length > 0) {
            message += `📋 ${todayFollowups.length} follow-up${todayFollowups.length > 1 ? 's' : ''} today!`;
        }
        reminderText.textContent = message;
        reminderBanner.classList.remove('hidden');
    }

    // Send browser notifications for tomorrow's follow-ups (1 day prior alert)
    if (Notification.permission === 'granted' && tomorrowFollowups.length > 0) {
        const lastNotifDate = localStorage.getItem('last_notif_date');
        const todayStr = getLocalDateString(today);

        // Only send notification once per day
        if (lastNotifDate !== todayStr) {
            localStorage.setItem('last_notif_date', todayStr);

            tomorrowFollowups.forEach(f => {
                const typeIcon = TYPE_ICONS[f.type] || '📋';
                new Notification(`🏠 PropertyPulse Reminder`, {
                    body: `${typeIcon} Follow-up with ${f.name} tomorrow!\n${f.property || ''}`,
                    icon: '🏠',
                    tag: f.id,
                    requireInteraction: true
                });
            });
        }
    }

    // Also send notifications for overdue
    if (Notification.permission === 'granted' && overdueFollowups.length > 0) {
        const lastOverdueNotif = localStorage.getItem('last_overdue_notif');
        const todayStr = getLocalDateString(today);

        if (lastOverdueNotif !== todayStr) {
            localStorage.setItem('last_overdue_notif', todayStr);

            new Notification(`⚠️ Overdue Follow-ups!`, {
                body: `You have ${overdueFollowups.length} overdue follow-up${overdueFollowups.length > 1 ? 's' : ''}. Open PropertyPulse to check.`,
                tag: 'overdue-alert',
                requireInteraction: true
            });
        }
    }
}

// ========== Toast Notifications ==========
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    toast.innerHTML = `<span>${icons[type] || ''}</span> ${message}`;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'toastOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ========== Utility ==========
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
