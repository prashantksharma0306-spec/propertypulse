/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PropertyPulse — Real Estate Follow-Up Tracker                         ║
 * ║  Complete JavaScript Backend                                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Architecture:
 *   1. Database Layer   — IndexedDB wrapper (PropertyPulseDB)
 *   2. Client CRUD      — add / update / delete / get / search
 *   3. Dashboard Logic  — follow-up queries, greeting, stats
 *   4. Notifications    — browser push reminders
 *   5. Backup / Restore — JSON export & import
 *   6. UI Controller    — views, nav, form, toasts, animations
 *   7. Service Worker   — registration
 */
;(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  //  0.  CONSTANTS & CONFIG
  // ═══════════════════════════════════════════════════════════════════════════

  const DB_NAME    = 'PropertyPulseDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'clients';

  const DAY_NAMES  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_FULL   = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const STATUS_LABELS = {
    active:     'Active',
    interested: 'Interested',
    warm:       'Warm',
    cold:       'Cold',
    closed:     'Closed'
  };

  const PRIORITY_LABELS = {
    high:   'High',
    medium: 'Medium',
    low:    'Low'
  };

  const REMINDER_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes

  // ═══════════════════════════════════════════════════════════════════════════
  //  1.  UTILITY HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Generate a UUID v4 */
  function generateId() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    // Fallback
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /** Escape HTML to prevent XSS */
  function escapeHtml(text) {
    if (!text) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, (m) => map[m]);
  }

  /** Time-of-day greeting */
  function getTimeGreeting() {
    const h = new Date().getHours();
    if (h < 12)  return 'Good Morning';
    if (h < 17)  return 'Good Afternoon';
    return 'Good Evening';
  }

  /** Human-readable relative time */
  function formatRelativeTime(dateString) {
    if (!dateString) return 'Never';
    const now  = Date.now();
    const then = new Date(dateString).getTime();
    const diff = now - then;

    if (diff < 0) return 'just now';

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours   = Math.floor(minutes / 60);
    const days    = Math.floor(hours / 24);
    const weeks   = Math.floor(days / 7);
    const months  = Math.floor(days / 30);

    if (seconds < 60) return 'just now';
    if (minutes === 1) return '1 minute ago';
    if (minutes < 60)  return `${minutes} minutes ago`;
    if (hours === 1)   return '1 hour ago';
    if (hours < 24)    return `${hours} hours ago`;
    if (days === 1)    return 'yesterday';
    if (days < 7)      return `${days} days ago`;
    if (weeks === 1)   return '1 week ago';
    if (weeks < 5)     return `${weeks} weeks ago`;
    if (months === 1)  return '1 month ago';
    return `${months} months ago`;
  }

  /** Animated number counter */
  function animateValue(element, start, end, duration) {
    if (!element) return;
    if (start === end) { element.textContent = end; return; }
    const range     = end - start;
    const startTime = performance.now();

    function step(currentTime) {
      const elapsed  = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out quad
      const eased = 1 - (1 - progress) * (1 - progress);
      element.textContent = Math.round(start + range * eased);
      if (progress < 1) requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  }

  /** Debounce helper */
  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  /** Get today's day-of-week number (0 = Sun … 6 = Sat) */
  function todayDow() { return new Date().getDay(); }

  /** Get tomorrow's day-of-week number */
  function tomorrowDow() { return (todayDow() + 1) % 7; }


  // ═══════════════════════════════════════════════════════════════════════════
  //  2.  INDEXEDDB DATA LAYER
  // ═══════════════════════════════════════════════════════════════════════════

  let _db = null;

  /** Open (or create) the database — returns a Promise<IDBDatabase> */
  function openDB() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('name',      'name',      { unique: false });
          store.createIndex('status',    'status',    { unique: false });
          store.createIndex('priority',  'priority',  { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };

      request.onsuccess = (e) => {
        _db = e.target.result;
        // Handle unexpected close
        _db.onclose = () => { _db = null; };
        resolve(_db);
      };

      request.onerror = (e) => {
        console.error('[DB] Failed to open:', e.target.error);
        reject(e.target.error);
      };
    });
  }

  /** Generic transaction helper */
  function withStore(mode, callback) {
    return openDB().then((db) => {
      return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        callback(store, resolve, reject);
        tx.onerror = () => reject(tx.error);
      });
    });
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  function addClient(data) {
    const now    = new Date().toISOString();
    const client = {
      id:            generateId(),
      name:          data.name          || '',
      phone:         data.phone         || '',
      email:         data.email         || '',
      property:      data.property      || '',
      propertyType:  data.propertyType  || 'Other',
      budget:        data.budget        || '',
      followupDays:  data.followupDays  || [],
      priority:      data.priority      || 'medium',
      status:        data.status        || 'active',
      notes:         data.notes         || '',
      createdAt:     now,
      updatedAt:     now,
      lastContacted: null
    };

    return withStore('readwrite', (store, resolve, reject) => {
      const req = store.add(client);
      req.onsuccess = () => resolve(client);
      req.onerror   = () => reject(req.error);
    });
  }

  function updateClient(id, data) {
    return getClient(id).then((existing) => {
      if (!existing) throw new Error('Client not found');
      const updated = {
        ...existing,
        ...data,
        id,                                  // never overwrite the key
        updatedAt: new Date().toISOString()
      };
      return withStore('readwrite', (store, resolve, reject) => {
        const req = store.put(updated);
        req.onsuccess = () => resolve(updated);
        req.onerror   = () => reject(req.error);
      });
    });
  }

  function deleteClient(id) {
    return withStore('readwrite', (store, resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  function getClient(id) {
    return withStore('readonly', (store, resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  }

  function getAllClients() {
    return withStore('readonly', (store, resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  function searchClients(query) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return getAllClients();

    return getAllClients().then((clients) =>
      clients.filter((c) =>
        (c.name      || '').toLowerCase().includes(q) ||
        (c.phone     || '').toLowerCase().includes(q) ||
        (c.property  || '').toLowerCase().includes(q) ||
        (c.email     || '').toLowerCase().includes(q)
      )
    );
  }

  function markContacted(id) {
    return updateClient(id, { lastContacted: new Date().toISOString() });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  3.  DASHBOARD / FOLLOW-UP LOGIC
  // ═══════════════════════════════════════════════════════════════════════════

  /** Clients that have a follow-up on a given day (exclude closed) */
  function getFollowupsForDay(dayNumber) {
    return getAllClients().then((clients) =>
      clients.filter((c) =>
        c.status !== 'closed' &&
        Array.isArray(c.followupDays) &&
        c.followupDays.includes(dayNumber)
      )
    );
  }

  function getTodayFollowups()    { return getFollowupsForDay(todayDow()); }
  function getTomorrowFollowups() { return getFollowupsForDay(tomorrowDow()); }

  /** Count of follow-ups per day for the current week (Sun–Sat) */
  function getWeekOverview() {
    return getAllClients().then((clients) => {
      const active = clients.filter((c) => c.status !== 'closed');
      const counts = {};
      for (let d = 0; d < 7; d++) {
        counts[d] = active.filter(
          (c) => Array.isArray(c.followupDays) && c.followupDays.includes(d)
        ).length;
      }
      return counts;
    });
  }

  /** Dashboard summary stats */
  function getDashboardStats() {
    return getAllClients().then((clients) => {
      const total      = clients.length;
      const active     = clients.filter((c) => c.status !== 'closed').length;
      const highP      = clients.filter((c) => c.priority === 'high' && c.status !== 'closed').length;
      const interested = clients.filter((c) => c.status === 'interested').length;
      const closed     = clients.filter((c) => c.status === 'closed').length;
      return { total, active, highP, interested, closed };
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  4.  NOTIFICATION SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  function requestNotificationPermission() {
    if (!('Notification' in window)) {
      console.warn('[Notify] Notifications not supported');
      return Promise.resolve('unsupported');
    }
    if (Notification.permission === 'granted') return Promise.resolve('granted');
    if (Notification.permission === 'denied')  return Promise.resolve('denied');
    return Notification.requestPermission();
  }

  /** Send a browser notification */
  function sendNotification(title, body, tag) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      new Notification(title, {
        body,
        icon:  './icons/icon-192.png',
        badge: './icons/icon-192.png',
        tag:   tag || 'propertypulse',
        vibrate: [100, 50, 100]
      });
    } catch (e) {
      // Some browsers only allow notifications from SW
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification(title, {
            body,
            icon:  './icons/icon-192.png',
            badge: './icons/icon-192.png',
            tag:   tag || 'propertypulse',
            vibrate: [100, 50, 100]
          });
        });
      }
    }
  }

  /**
   * Check and send reminder notifications.
   * Uses localStorage key `pp_last_notify_date` to avoid spamming.
   */
  function checkAndSendReminders() {
    const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lastKey  = localStorage.getItem('pp_last_notify_date');

    // Already sent today
    if (lastKey === todayKey) return;

    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    Promise.all([getTodayFollowups(), getTomorrowFollowups()]).then(([today, tomorrow]) => {
      if (today.length > 0) {
        const names = today.slice(0, 3).map((c) => c.name).join(', ');
        const extra = today.length > 3 ? ` +${today.length - 3} more` : '';
        sendNotification(
          `📋 ${today.length} Follow-up${today.length > 1 ? 's' : ''} Today`,
          `${names}${extra}`,
          'pp-today'
        );
      }

      if (tomorrow.length > 0) {
        const names = tomorrow.slice(0, 3).map((c) => c.name).join(', ');
        const extra = tomorrow.length > 3 ? ` +${tomorrow.length - 3} more` : '';
        sendNotification(
          `🔔 ${tomorrow.length} Follow-up${tomorrow.length > 1 ? 's' : ''} Tomorrow`,
          `${names}${extra}`,
          'pp-tomorrow'
        );
      }

      localStorage.setItem('pp_last_notify_date', todayKey);
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  5.  DATA BACKUP & RESTORE
  // ═══════════════════════════════════════════════════════════════════════════

  /** Export all clients as a downloadable JSON file */
  function exportData() {
    return getAllClients().then((clients) => {
      const payload = {
        app:       'PropertyPulse',
        version:   1,
        exportedAt: new Date().toISOString(),
        clients
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');

      a.href     = url;
      a.download = `PropertyPulse_Backup_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showToast('Backup downloaded successfully', 'success');
    });
  }

  /** Import clients from a JSON backup file */
  function importData(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('No file selected'));

      const reader = new FileReader();

      reader.onload = (e) => {
        try {
          const data = JSON.parse(e.target.result);
          let clients;

          // Support both raw array and wrapped format
          if (Array.isArray(data)) {
            clients = data;
          } else if (data.clients && Array.isArray(data.clients)) {
            clients = data.clients;
          } else {
            throw new Error('Invalid backup format');
          }

          if (clients.length === 0) {
            showToast('Backup file is empty', 'warning');
            return resolve(0);
          }

          // Import each client (upsert — replace if id exists)
          openDB().then((db) => {
            const tx    = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            let count   = 0;

            clients.forEach((client) => {
              // Ensure required fields
              if (!client.id) client.id = generateId();
              if (!client.createdAt) client.createdAt = new Date().toISOString();
              if (!client.updatedAt) client.updatedAt = new Date().toISOString();
              if (!Array.isArray(client.followupDays)) client.followupDays = [];

              store.put(client);
              count++;
            });

            tx.oncomplete = () => {
              showToast(`Imported ${count} client${count !== 1 ? 's' : ''} successfully`, 'success');
              refreshCurrentView();
              resolve(count);
            };
            tx.onerror = () => {
              showToast('Import failed: ' + tx.error, 'error');
              reject(tx.error);
            };
          });
        } catch (err) {
          showToast('Invalid file: ' + err.message, 'error');
          reject(err);
        }
      };

      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  6.  UI CONTROLLER
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Cached DOM References (populated on DOMContentLoaded) ─────────────────
  let $views, $navItems, $addModal, $deleteModal, $clientForm,
      $editClientId, $searchInput, $filterChips, $reminderTabs,
      $toastContainer, $greeting, $statsCards, $modalTitle,
      $weekGrid, $importInput;

  /** Cache all DOM elements */
  function cacheDom() {
    $views          = document.querySelectorAll('.view');
    $navItems       = document.querySelectorAll('[data-view]');
    $addModal       = document.getElementById('add-modal');
    $deleteModal    = document.getElementById('delete-modal');
    $clientForm     = document.getElementById('client-form');
    $editClientId   = document.getElementById('edit-client-id');
    $searchInput    = document.getElementById('search-clients');
    $filterChips    = document.querySelectorAll('.filter-chip');
    $reminderTabs   = document.querySelectorAll('.reminder-tab');
    $toastContainer = document.getElementById('toast-container');
    $greeting       = document.getElementById('greeting');
    $modalTitle     = document.getElementById('modal-title');
    $weekGrid       = document.getElementById('week-grid');
    $importInput    = document.getElementById('import-input');
  }


  // ── Toast Notifications ───────────────────────────────────────────────────

  function showToast(message, type = 'info') {
    if (!$toastContainer) return;

    const icons = {
      success: '✓',
      error:   '✕',
      warning: '⚠',
      info:    'ℹ'
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <span class="toast-message">${escapeHtml(message)}</span>
    `;

    $toastContainer.appendChild(toast);

    // Trigger entrance animation
    requestAnimationFrame(() => toast.classList.add('toast-visible'));

    // Auto-dismiss after 3 seconds
    setTimeout(() => {
      toast.classList.remove('toast-visible');
      toast.classList.add('toast-exit');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
      // Fallback removal
      setTimeout(() => { if (toast.parentNode) toast.remove(); }, 500);
    }, 3000);
  }


  // ── Ripple Effect ─────────────────────────────────────────────────────────

  function createRipple(event) {
    const button = event.currentTarget;
    const rect   = button.getBoundingClientRect();

    const ripple = document.createElement('span');
    ripple.className = 'ripple-effect';

    const size = Math.max(rect.width, rect.height);
    ripple.style.width  = ripple.style.height = `${size}px`;
    ripple.style.left   = `${event.clientX - rect.left - size / 2}px`;
    ripple.style.top    = `${event.clientY - rect.top - size / 2}px`;

    button.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
  }


  // ── Navigation ────────────────────────────────────────────────────────────

  let currentView = 'home';

  function switchView(viewName) {
    currentView = viewName;

    // Update nav active state
    $navItems.forEach((item) => {
      item.classList.toggle('active', item.getAttribute('data-view') === viewName);
    });

    // Show/hide views with animation
    $views.forEach((view) => {
      const isTarget = view.id === `view-${viewName}`;
      if (isTarget) {
        view.classList.add('active');
        view.style.display = '';
        // Animate in
        requestAnimationFrame(() => {
          view.style.opacity   = '1';
          view.style.transform = 'translateY(0)';
        });
      } else {
        view.classList.remove('active');
        view.style.opacity   = '0';
        view.style.transform = 'translateY(12px)';
        // Hide after transition
        setTimeout(() => {
          if (!view.classList.contains('active')) view.style.display = 'none';
        }, 200);
      }
    });

    // Render the view content
    if (viewName === 'home')      renderDashboard();
    if (viewName === 'clients')   renderClientsList();
    if (viewName === 'reminders') renderReminders();
  }


  // ── Modal ─────────────────────────────────────────────────────────────────

  function openAddModal(clientId) {
    if (!$addModal) return;

    // Reset form
    if ($clientForm) $clientForm.reset();
    if ($editClientId) $editClientId.value = '';

    // Reset all day toggles
    document.querySelectorAll('.day-toggle').forEach((t) => t.classList.remove('active'));

    if (clientId) {
      // Edit mode — populate form
      if ($modalTitle) $modalTitle.textContent = 'Edit Client';
      getClient(clientId).then((client) => {
        if (!client) return showToast('Client not found', 'error');
        $editClientId.value = client.id;
        fillForm(client);
      });
    } else {
      if ($modalTitle) $modalTitle.textContent = 'Add New Client';
    }

    $addModal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeAddModal() {
    if (!$addModal) return;
    $addModal.classList.remove('open');
    document.body.style.overflow = '';
  }

  function openDeleteModal(clientId) {
    if (!$deleteModal) return;
    $deleteModal.dataset.clientId = clientId;
    $deleteModal.classList.add('open');
  }

  function closeDeleteModal() {
    if (!$deleteModal) return;
    $deleteModal.classList.remove('open');
    delete $deleteModal.dataset.clientId;
  }

  function confirmDelete() {
    const id = $deleteModal && $deleteModal.dataset.clientId;
    if (!id) return;
    deleteClient(id).then(() => {
      showToast('Client deleted', 'success');
      closeDeleteModal();
      refreshCurrentView();
    }).catch((err) => {
      showToast('Delete failed: ' + err.message, 'error');
    });
  }

  /** Fill the add/edit form with client data */
  function fillForm(client) {
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val || '';
    };

    setVal('client-name',     client.name);
    setVal('client-phone',    client.phone);
    setVal('client-email',    client.email);
    setVal('client-property', client.property);
    setVal('property-type',   client.propertyType);
    setVal('client-budget',   client.budget);
    setVal('client-priority', client.priority);
    setVal('client-status',   client.status);
    setVal('client-notes',    client.notes);

    // Set follow-up day toggles
    document.querySelectorAll('.day-toggle').forEach((t) => {
      const day = parseInt(t.dataset.day, 10);
      t.classList.toggle('active', (client.followupDays || []).includes(day));
    });
  }


  // ── Form Submit ───────────────────────────────────────────────────────────

  function handleFormSubmit(e) {
    e.preventDefault();

    const getVal = (id) => {
      const el = document.getElementById(id);
      return el ? el.value.trim() : '';
    };

    const name  = getVal('client-name');
    const phone = getVal('client-phone');

    // Basic validation
    if (!name) { showToast('Client name is required', 'warning'); return; }
    if (!phone) { showToast('Phone number is required', 'warning'); return; }

    // Collect selected follow-up days
    const followupDays = [];
    document.querySelectorAll('.day-toggle.active').forEach((t) => {
      followupDays.push(parseInt(t.dataset.day, 10));
    });

    const data = {
      name,
      phone,
      email:        getVal('client-email'),
      property:     getVal('client-property'),
      propertyType: getVal('property-type')   || 'Other',
      budget:       getVal('client-budget'),
      priority:     getVal('client-priority')  || 'medium',
      status:       getVal('client-status')    || 'active',
      notes:        getVal('client-notes'),
      followupDays
    };

    const editId = $editClientId ? $editClientId.value : '';

    const action = editId
      ? updateClient(editId, data)
      : addClient(data);

    action
      .then(() => {
        showToast(editId ? 'Client updated' : 'Client added', 'success');
        closeAddModal();
        refreshCurrentView();
      })
      .catch((err) => {
        showToast('Save failed: ' + err.message, 'error');
      });
  }


  // ── Render: Dashboard ─────────────────────────────────────────────────────

  function renderDashboard() {
    // Greeting
    if ($greeting) $greeting.textContent = getTimeGreeting();

    // Stats
    getDashboardStats().then((stats) => {
      animateStatCard('stat-total',      stats.total);
      animateStatCard('stat-active',     stats.active);
      animateStatCard('stat-high',       stats.highP);
      animateStatCard('stat-interested', stats.interested);
    });

    // Today's follow-ups preview
    getTodayFollowups().then((clients) => {
      const container = document.getElementById('today-preview');
      if (!container) return;

      if (clients.length === 0) {
        container.innerHTML = `
          <div class="empty-state small">
            <span class="empty-icon">☕</span>
            <p>No follow-ups scheduled for today</p>
          </div>`;
        return;
      }

      // Sort: high priority first
      const sorted = clients.sort(prioritySort);

      container.innerHTML = sorted.slice(0, 5).map((c) => clientCardMini(c)).join('');

      if (clients.length > 5) {
        container.innerHTML += `
          <button class="see-all-btn" onclick="PP.switchView('reminders')">
            See all ${clients.length} follow-ups →
          </button>`;
      }
    });

    // Week overview
    renderWeekOverview();
  }

  function animateStatCard(elementId, value) {
    const el = document.getElementById(elementId);
    if (!el) return;
    animateValue(el, 0, value, 600);
  }

  function renderWeekOverview() {
    if (!$weekGrid) return;
    getWeekOverview().then((counts) => {
      const today = todayDow();
      $weekGrid.innerHTML = DAY_NAMES.map((name, i) => {
        const isToday = i === today;
        const count   = counts[i] || 0;
        return `
          <div class="week-day ${isToday ? 'today' : ''} ${count > 0 ? 'has-followups' : ''}">
            <span class="week-day-name">${name}</span>
            <span class="week-day-count">${count}</span>
          </div>`;
      }).join('');
    });
  }


  // ── Render: Clients List ──────────────────────────────────────────────────

  let currentFilter = 'all';

  function renderClientsList(filterOverride) {
    const filter = filterOverride || currentFilter;
    const query  = $searchInput ? $searchInput.value.trim() : '';

    const fetcher = query ? searchClients(query) : getAllClients();

    fetcher.then((clients) => {
      // Apply filter
      let filtered = clients;
      switch (filter) {
        case 'high':
          filtered = clients.filter((c) => c.priority === 'high' && c.status !== 'closed');
          break;
        case 'active':
          filtered = clients.filter((c) => c.status === 'active');
          break;
        case 'interested':
          filtered = clients.filter((c) => c.status === 'interested');
          break;
        case 'closed':
          filtered = clients.filter((c) => c.status === 'closed');
          break;
      }

      // Sort: high priority first, then by name
      filtered.sort(prioritySort);

      const container = document.getElementById('clients-list');
      if (!container) return;

      // Client count
      const countEl = document.getElementById('clients-count');
      if (countEl) countEl.textContent = `${filtered.length} client${filtered.length !== 1 ? 's' : ''}`;

      if (filtered.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <span class="empty-icon">📋</span>
            <h3>${query ? 'No matches found' : 'No clients yet'}</h3>
            <p>${query ? 'Try a different search term' : 'Tap the + button to add your first client'}</p>
          </div>`;
        return;
      }

      container.innerHTML = filtered.map((c) => clientCard(c)).join('');
    });
  }

  function prioritySort(a, b) {
    const order = { high: 0, medium: 1, low: 2 };
    const pa    = order[a.priority] ?? 1;
    const pb    = order[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    return (a.name || '').localeCompare(b.name || '');
  }


  // ── Render: Reminders ─────────────────────────────────────────────────────

  let currentReminderTab = 'today';

  function renderReminders(tabOverride) {
    const tab = tabOverride || currentReminderTab;
    currentReminderTab = tab;

    // Update tab active state
    $reminderTabs.forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });

    const container = document.getElementById('reminders-list');
    if (!container) return;

    if (tab === 'today') {
      getTodayFollowups().then((clients) => {
        renderReminderList(container, clients, 'No follow-ups today', '☕', 'Enjoy your free time!');
      });
    } else if (tab === 'tomorrow') {
      getTomorrowFollowups().then((clients) => {
        renderReminderList(container, clients, 'No follow-ups tomorrow', '📅', 'Tomorrow is clear!');
      });
    } else if (tab === 'week') {
      renderWeekView(container);
    }
  }

  function renderReminderList(container, clients, emptyTitle, emptyIcon, emptySubtitle) {
    if (clients.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">${emptyIcon}</span>
          <h3>${emptyTitle}</h3>
          <p>${emptySubtitle}</p>
        </div>`;
      return;
    }

    clients.sort(prioritySort);
    container.innerHTML = clients.map((c) => clientCard(c, true)).join('');
  }

  function renderWeekView(container) {
    const promises = [];
    for (let d = 0; d < 7; d++) {
      promises.push(getFollowupsForDay(d));
    }

    Promise.all(promises).then((results) => {
      const today = todayDow();
      let html = '';

      results.forEach((clients, dayNum) => {
        const isToday    = dayNum === today;
        const isTomorrow = dayNum === tomorrowDow();
        let label = DAY_FULL[dayNum];
        if (isToday)    label += ' (Today)';
        if (isTomorrow) label += ' (Tomorrow)';

        html += `
          <div class="week-section ${isToday ? 'today' : ''}">
            <div class="week-section-header">
              <h3>${label}</h3>
              <span class="badge">${clients.length}</span>
            </div>`;

        if (clients.length === 0) {
          html += `<p class="week-empty">No follow-ups</p>`;
        } else {
          clients.sort(prioritySort);
          html += clients.map((c) => clientCardMini(c)).join('');
        }

        html += `</div>`;
      });

      container.innerHTML = html;
    });
  }


  // ── Client Card Templates ─────────────────────────────────────────────────

  function clientCard(client, showContactBtn = false) {
    const statusClass   = `status-${client.status}`;
    const priorityClass = `priority-${client.priority}`;
    const contacted     = client.lastContacted
      ? `Last contacted: ${formatRelativeTime(client.lastContacted)}`
      : 'Not yet contacted';

    const followupDays = (client.followupDays || [])
      .sort((a, b) => a - b)
      .map((d) => DAY_NAMES[d])
      .join(', ');

    return `
      <div class="client-card ${priorityClass}" data-id="${client.id}">
        <div class="client-card-header">
          <div class="client-info">
            <h3 class="client-name">${escapeHtml(client.name)}</h3>
            <span class="client-property-badge">${escapeHtml(client.propertyType || 'Other')}</span>
          </div>
          <div class="client-badges">
            <span class="badge ${statusClass}">${STATUS_LABELS[client.status] || client.status}</span>
            <span class="badge ${priorityClass}">${PRIORITY_LABELS[client.priority] || client.priority}</span>
          </div>
        </div>

        ${client.property ? `<p class="client-property">🏠 ${escapeHtml(client.property)}</p>` : ''}
        ${client.budget   ? `<p class="client-budget">💰 ${escapeHtml(client.budget)}</p>` : ''}

        <div class="client-contact-row">
          <a href="tel:${escapeHtml(client.phone)}" class="contact-link phone-link" title="Call">
            📞 ${escapeHtml(client.phone)}
          </a>
          <a href="https://wa.me/${cleanPhone(client.phone)}" target="_blank" rel="noopener"
             class="contact-link whatsapp-link" title="WhatsApp">
            💬 WhatsApp
          </a>
        </div>

        ${client.email ? `<p class="client-email">✉️ ${escapeHtml(client.email)}</p>` : ''}

        <div class="client-meta">
          <span class="meta-followup">📅 ${followupDays || 'No days set'}</span>
          <span class="meta-contacted">${contacted}</span>
        </div>

        ${client.notes ? `<p class="client-notes">${escapeHtml(client.notes)}</p>` : ''}

        <div class="client-actions">
          ${showContactBtn ? `<button class="btn-sm btn-contacted" onclick="PP.markContacted('${client.id}')">✓ Contacted</button>` : ''}
          <button class="btn-sm btn-edit" onclick="PP.openAddModal('${client.id}')">✏️ Edit</button>
          <button class="btn-sm btn-delete" onclick="PP.openDeleteModal('${client.id}')">🗑️</button>
        </div>
      </div>`;
  }

  function clientCardMini(client) {
    const priorityClass = `priority-${client.priority}`;
    const statusClass   = `status-${client.status}`;

    return `
      <div class="client-card-mini ${priorityClass}" data-id="${client.id}">
        <div class="mini-left">
          <span class="mini-name">${escapeHtml(client.name)}</span>
          <span class="mini-property">${escapeHtml(client.property || client.propertyType || '')}</span>
        </div>
        <div class="mini-right">
          <span class="badge small ${statusClass}">${STATUS_LABELS[client.status] || client.status}</span>
          <div class="mini-actions">
            <a href="tel:${escapeHtml(client.phone)}" class="mini-action" title="Call">📞</a>
            <a href="https://wa.me/${cleanPhone(client.phone)}" target="_blank" rel="noopener"
               class="mini-action" title="WhatsApp">💬</a>
            <button class="mini-action" onclick="PP.markContacted('${client.id}')" title="Mark contacted">✓</button>
          </div>
        </div>
      </div>`;
  }

  /** Strip non-digits from phone for WhatsApp link */
  function cleanPhone(phone) {
    return (phone || '').replace(/[^0-9]/g, '');
  }


  // ── Search & Filter ───────────────────────────────────────────────────────

  const debouncedSearch = debounce(() => renderClientsList(), 200);

  function handleSearch() {
    debouncedSearch();
  }

  function handleFilter(filter) {
    currentFilter = filter;
    $filterChips.forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.filter === filter);
    });
    renderClientsList(filter);
  }


  // ── View Refresh Helper ───────────────────────────────────────────────────

  function refreshCurrentView() {
    switchView(currentView);
  }


  // ── Event Binding ─────────────────────────────────────────────────────────

  function bindEvents() {
    // Bottom nav
    $navItems.forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const view = item.getAttribute('data-view');
        if (view) switchView(view);
        createRipple(e);
      });
    });

    // Form submit
    if ($clientForm) {
      $clientForm.addEventListener('submit', handleFormSubmit);
    }

    // Search input
    if ($searchInput) {
      $searchInput.addEventListener('input', handleSearch);
    }

    // Filter chips — event delegation
    $filterChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        handleFilter(chip.dataset.filter);
      });
    });

    // Reminder tabs
    $reminderTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        renderReminders(tab.dataset.tab);
      });
    });

    // Day toggles — event delegation
    document.addEventListener('click', (e) => {
      const dayToggle = e.target.closest('.day-toggle');
      if (dayToggle) {
        dayToggle.classList.toggle('active');
      }
    });

    // Modal close — click backdrop
    if ($addModal) {
      $addModal.addEventListener('click', (e) => {
        if (e.target === $addModal) closeAddModal();
      });
    }
    if ($deleteModal) {
      $deleteModal.addEventListener('click', (e) => {
        if (e.target === $deleteModal) closeDeleteModal();
      });
    }

    // Import file input
    if ($importInput) {
      $importInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          importData(file).finally(() => {
            $importInput.value = ''; // Reset so same file can be re-selected
          });
        }
      });
    }

    // Keyboard: Escape closes modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAddModal();
        closeDeleteModal();
      }
    });

    // Ripple effect on all buttons
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button, .btn, .nav-item');
      if (btn && !e.target.closest('.client-card')) {
        createRipple(e);
      }
    });
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  7.  SERVICE WORKER REGISTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('./sw.js')
        .then((reg) => {
          console.log('[SW] Registered:', reg.scope);

          // Check for updates periodically
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated') {
                showToast('App updated! Refresh for the latest version.', 'info');
              }
            });
          });
        })
        .catch((err) => console.warn('[SW] Registration failed:', err));
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  8.  INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    cacheDom();
    bindEvents();

    // Open database first, then render
    openDB()
      .then(() => {
        switchView('home');
        console.log('[PP] PropertyPulse initialized');
      })
      .catch((err) => {
        console.error('[PP] Init failed:', err);
        showToast('Failed to open database', 'error');
      });

    // Register service worker
    registerServiceWorker();

    // Request notification permission (non-blocking)
    requestNotificationPermission();

    // Send reminders on load
    checkAndSendReminders();

    // Re-check reminders every 30 minutes
    setInterval(checkAndSendReminders, REMINDER_CHECK_INTERVAL);
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  9.  PUBLIC API (window.PP)
  // ═══════════════════════════════════════════════════════════════════════════
  //  Exposed for inline onclick handlers and external access.

  window.PP = {
    // Navigation
    switchView,

    // Modal
    openAddModal,
    closeAddModal,
    openDeleteModal,
    closeDeleteModal,
    confirmDelete,

    // Actions
    markContacted: (id) => {
      markContacted(id).then(() => {
        showToast('Marked as contacted', 'success');
        refreshCurrentView();
      }).catch((err) => {
        showToast('Failed: ' + err.message, 'error');
      });
    },

    // Backup / Restore
    exportData,
    importData,
    triggerImport: () => {
      if ($importInput) $importInput.click();
    },

    // Toast (for external use)
    showToast,

    // Utility (for external use)
    formatRelativeTime,
    getTimeGreeting,

    // Direct DB access (for debugging / external integrations)
    db: {
      addClient,
      updateClient,
      deleteClient,
      getClient,
      getAllClients,
      searchClients,
      getTodayFollowups,
      getTomorrowFollowups,
      getWeekOverview,
      getDashboardStats
    }
  };

})();
