// Everything here runs entirely on the phone. Appointments are written to
// localStorage the moment they're saved - no network involved at all for
// that step. The only time this page talks to anything else is when you
// explicitly tap "Synchroniseren", and even then it only ever talks to the
// Macbook app directly over the local network - never anywhere else.
//
// "Toevoegen aan agenda" is a separate, independent action: it builds a
// standard .ics calendar file for one appointment and hands it to the
// phone's own share sheet. It never touches the Macbook or any server -
// it's pure local file generation, so it works instantly, offline, and
// regardless of whether the Macbook has ever been synced.

const PENDING_KEY = 'zzp_pending_appointments';
const TOKEN_KEY = 'zzp_sync_token';
const SERVER_KEY = 'zzp_sync_server';

function loadPending() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function savePending(list) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(list));
}

// Reads the pairing token and the Macbook's current local address from the
// URL the very first time (or any time a fresh QR code is scanned again,
// e.g. after the Macbook's address changes), stores both, then tidies the
// address bar so neither sits there visibly. This app itself is hosted at
// a fixed, stable address that never changes - only the "where's the
// Macbook right now" address needs updating when that drifts, which is
// exactly what re-scanning a fresh QR code does, without ever needing to
// reinstall this app.
function getPairing() {
  const params = new URLSearchParams(location.search);
  const fromUrlToken = params.get('t');
  const fromUrlServer = params.get('server');
  if (fromUrlToken && fromUrlServer) {
    localStorage.setItem(TOKEN_KEY, fromUrlToken);
    localStorage.setItem(SERVER_KEY, fromUrlServer);
    history.replaceState({}, '', location.pathname);
  }
  return {
    token: localStorage.getItem(TOKEN_KEY),
    server: localStorage.getItem(SERVER_KEY)
  };
}

const { token, server } = getPairing();

const pendingListEl = document.getElementById('pending-list');
const pendingCountEl = document.getElementById('pending-count');
const syncBtn = document.getElementById('sync-btn');
const syncMessageEl = document.getElementById('sync-message');
const statusEl = document.getElementById('connection-status');
const pairingSection = document.getElementById('pairing-section');
const form = document.getElementById('appt-form');
const saveConfirmEl = document.getElementById('save-confirm');
const saveConfirmCalBtn = document.getElementById('save-confirm-cal-btn');

if (!token || !server) {
  pairingSection.classList.remove('hidden');
  syncBtn.disabled = true;
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

// ---- Calendar (.ics) export - entirely local, no server involved ----

function pad(n) {
  return String(n).padStart(2, '0');
}

// Escapes text per RFC5545 3.3.11 (comma, semicolon, backslash, newline).
function icsEscape(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function formatIcsDateTime(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
}

function formatIcsDate(y, m, d) {
  return `${y}${pad(m)}${pad(d)}`;
}

function slugify(str) {
  const slug = String(str || 'afspraak')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || 'afspraak';
}

// Builds a single-event .ics file. Uses a "floating" local time (no
// timezone conversion, no Z suffix) since this app is single-timezone by
// design - that's what every calendar app interprets as "your local time"
// when importing. If no time was entered, falls back to a simple all-day
// event rather than guessing a time.
function buildIcsForAppointment(appt) {
  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const uid = `${appt.id}@zzp-boekhouding.local`;
  const summary = icsEscape(`Kapper: ${appt.client}`);
  const location = icsEscape(appt.address || '');
  const descParts = [];
  if (appt.note) descParts.push(appt.note);
  if (appt.expectedOmzet) descParts.push(`Verwachte omzet: \u20ac${appt.expectedOmzet}`);
  const description = icsEscape(descParts.join(' - '));

  const [y, m, d] = (appt.date || '').split('-').map(Number);
  let dtstartLine, dtendLine;

  if (appt.time) {
    const [hh, mm] = appt.time.split(':').map(Number);
    const start = new Date(y, m - 1, d, hh, mm, 0);
    const durationHours = parseFloat(appt.hours) > 0 ? parseFloat(appt.hours) : 1;
    const end = new Date(start.getTime() + durationHours * 60 * 60 * 1000);
    dtstartLine = `DTSTART:${formatIcsDateTime(start)}`;
    dtendLine = `DTEND:${formatIcsDateTime(end)}`;
  } else {
    const startDate = formatIcsDate(y, m, d);
    const nextDay = new Date(y, m - 1, d + 1);
    const endDate = formatIcsDate(nextDay.getFullYear(), nextDay.getMonth() + 1, nextDay.getDate());
    dtstartLine = `DTSTART;VALUE=DATE:${startDate}`;
    dtendLine = `DTEND;VALUE=DATE:${endDate}`;
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ZZP Boekhouding//Afspraken//NL',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    dtstartLine,
    dtendLine,
    `SUMMARY:${summary}`
  ];
  if (location) lines.push(`LOCATION:${location}`);
  if (description) lines.push(`DESCRIPTION:${description}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');

  return lines.join('\r\n');
}

// Hands the .ics file to the phone's native share sheet (so it can go
// straight to FamilyWall, the native calendar, or anywhere else you pick),
// falling back to a plain download if the share sheet isn't available.
async function addToCalendar(appt) {
  const ics = buildIcsForAppointment(appt);
  const fileName = `afspraak-${appt.date}-${slugify(appt.client)}.ics`;
  const blob = new Blob([ics], { type: 'text/calendar' });

  const file = typeof File !== 'undefined' ? new File([blob], fileName, { type: 'text/calendar' }) : null;
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      // fall through to plain download on any other share failure
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function renderPending() {
  const pending = loadPending();
  pendingCountEl.textContent = pending.length;

  if (pending.length === 0) {
    pendingListEl.innerHTML = '<li class="empty">Nog geen afspraken wachtend</li>';
  } else {
    pendingListEl.innerHTML = '';
    pending
      .slice()
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .forEach((a) => {
        const li = document.createElement('li');
        const info = document.createElement('div');
        const timePart = a.time ? ` ${a.time}` : '';
        info.innerHTML = `<div>${a.client}</div><div class="meta">${formatDate(a.date)}${timePart}${a.expectedOmzet ? ' \u00b7 \u20ac' + a.expectedOmzet : ''}</div>`;

        const actions = document.createElement('div');
        actions.className = 'row-actions';

        const calBtn = document.createElement('button');
        calBtn.className = 'icon-btn';
        calBtn.title = 'Toevoegen aan agenda';
        calBtn.textContent = '\ud83d\udcc5';
        calBtn.onclick = () => addToCalendar(a);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-btn';
        removeBtn.textContent = '\u00d7';
        removeBtn.onclick = () => {
          savePending(loadPending().filter((p) => p.id !== a.id));
          renderPending();
        };

        actions.appendChild(calBtn);
        actions.appendChild(removeBtn);
        li.appendChild(info);
        li.appendChild(actions);
        pendingListEl.appendChild(li);
      });
  }

  syncBtn.disabled = pending.length === 0 || !token || !server;
}

let lastSavedAppointment = null;

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const appointment = {
    id: `phone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    date: document.getElementById('f-date').value,
    time: document.getElementById('f-time').value,
    client: document.getElementById('f-client').value.trim(),
    address: document.getElementById('f-address').value.trim(),
    km: parseFloat(document.getElementById('f-km').value) || 0,
    hours: parseFloat(document.getElementById('f-hours').value) || 0,
    expectedOmzet: parseFloat(document.getElementById('f-price').value) || 0,
    note: document.getElementById('f-note').value.trim(),
    linkedTransactionId: null
  };
  if (!appointment.date || !appointment.client) return;

  const pending = loadPending();
  pending.push(appointment);
  savePending(pending);
  form.reset();
  renderPending();

  lastSavedAppointment = appointment;
  saveConfirmEl.classList.remove('hidden');
});

saveConfirmCalBtn.addEventListener('click', () => {
  if (lastSavedAppointment) addToCalendar(lastSavedAppointment);
  saveConfirmEl.classList.add('hidden');
});

form.addEventListener('input', () => {
  saveConfirmEl.classList.add('hidden');
});

async function checkConnection() {
  if (!token || !server) {
    statusEl.textContent = 'Niet gekoppeld';
    statusEl.className = 'status offline';
    return false;
  }
  try {
    const res = await fetch(`${server}/api/ping`, {
      headers: { 'X-Sync-Token': token },
      signal: AbortSignal.timeout(2500)
    });
    if (res.status === 401) {
      // Reached the Mac fine, but it didn't recognise this pairing code -
      // a genuinely different problem from "unreachable", and worth
      // saying so, since the fix (re-pair) is different from "check wifi".
      statusEl.textContent = 'Koppelcode ongeldig - scan opnieuw';
      statusEl.className = 'status offline';
      return false;
    }
    if (!res.ok) throw new Error('not ok');
    statusEl.textContent = 'Macbook bereikbaar';
    statusEl.className = 'status online';
    return true;
  } catch (e) {
    statusEl.textContent = 'Macbook niet bereikbaar';
    statusEl.className = 'status offline';
    return false;
  }
}

syncBtn.addEventListener('click', async () => {
  syncMessageEl.textContent = '';
  const pending = loadPending();
  if (pending.length === 0 || !token || !server) return;

  syncBtn.disabled = true;
  syncBtn.textContent = 'Bezig met synchroniseren\u2026';

  try {
    const res = await fetch(`${server}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Token': token },
      body: JSON.stringify({ appointments: pending }),
      signal: AbortSignal.timeout(8000)
    });
    if (res.status === 401) throw new Error('invalid-token');
    if (!res.ok) throw new Error('sync failed');
    const data = await res.json();
    const accepted = new Set(data.accepted || []);
    const remaining = pending.filter((a) => !accepted.has(a.id));
    savePending(remaining);
    syncMessageEl.textContent = `${accepted.size} afspraak/afspraken gesynchroniseerd.`;
    syncMessageEl.style.color = 'var(--teal)';
  } catch (e) {
    syncMessageEl.textContent = e.message === 'invalid-token'
      ? 'Koppelcode ongeldig. Scan de QR-code in Instellingen opnieuw om je telefoon te herkoppelen.'
      : 'Kon geen verbinding maken met de Macbook-app. Zorg dat de app open staat en dat je op hetzelfde wifi-netwerk zit.';
    syncMessageEl.style.color = 'var(--red)';
  }

  syncBtn.textContent = 'Synchroniseren met Macbook';
  renderPending();
});

renderPending();
checkConnection();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((registration) => {
    // Force an immediate check against the live sw.js on every load,
    // rather than trusting the browser's own (often much lazier) default
    // update-check timing. Combined with the server sending no-cache for
    // this file, this makes sure a bug fix in the service worker actually
    // reaches an already-installed phone the next time it's opened,
    // instead of potentially sitting unnoticed for a long time.
    registration.update().catch(() => {});
  }).catch(() => {});
}
