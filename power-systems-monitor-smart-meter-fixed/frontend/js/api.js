/* Shared API client for every page. Loaded before each page's own script. */
const API_BASE = (window.POWER_MONITOR_API_BASE || 'http://localhost:4000') + '/api';

const Session = {
  setStation(token, station) {
    sessionStorage.setItem('pm_station_token', token);
    sessionStorage.setItem('pm_station', JSON.stringify(station));
  },
  getStationToken() { return sessionStorage.getItem('pm_station_token'); },
  getStation() {
    const raw = sessionStorage.getItem('pm_station');
    return raw ? JSON.parse(raw) : null;
  },
  clearStation() {
    sessionStorage.removeItem('pm_station_token');
    sessionStorage.removeItem('pm_station');
  },

  setAdmin(token, admin) {
    sessionStorage.setItem('pm_admin_token', token);
    sessionStorage.setItem('pm_admin', JSON.stringify(admin));
  },
  getAdminToken() { return sessionStorage.getItem('pm_admin_token'); },
  getAdmin() {
    const raw = sessionStorage.getItem('pm_admin');
    return raw ? JSON.parse(raw) : null;
  },
  clearAdmin() {
    sessionStorage.removeItem('pm_admin_token');
    sessionStorage.removeItem('pm_admin');
  }
};

async function apiRequest(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    throw new Error('Could not reach the API server. Is the backend running?');
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const Api = {
  stationLogin: (stationId, password) => apiRequest('/auth/station-login', { method: 'POST', body: { stationId, password } }),
  adminLogin: (username, password) => apiRequest('/auth/admin-login', { method: 'POST', body: { username, password } }),

  listCustomers: (search) => apiRequest(`/customers${search ? `?search=${encodeURIComponent(search)}` : ''}`, { token: Session.getStationToken() }),
  addCustomer: (payload) => apiRequest('/customers', { method: 'POST', body: payload, token: Session.getStationToken() }),
  updateCustomer: (id, payload) => apiRequest(`/customers/${id}`, { method: 'PUT', body: payload, token: Session.getStationToken() }),
  payCustomer: (id) => apiRequest(`/customers/${id}/pay`, { method: 'POST', token: Session.getStationToken() }),

  lookupBill: (meterId) => apiRequest(`/billing/lookup/${encodeURIComponent(meterId)}`),
  payBill: (meterId) => apiRequest(`/billing/pay/${encodeURIComponent(meterId)}`, { method: 'POST' }),
  analyzeConsumption: (meterId) => apiRequest(`/billing/analyze/${encodeURIComponent(meterId)}`),

  getTariff: () => apiRequest('/tariff'),
  updateTariff: (slabs) => apiRequest('/tariff', { method: 'PUT', body: { slabs }, token: Session.getAdminToken() }),

  getGrid: () => apiRequest('/grid'),
  updateFeeder: (panelId, subName, feederId, voltage, token) =>
    apiRequest(`/grid/${panelId}/${encodeURIComponent(subName)}/${feederId}`, { method: 'PUT', body: { voltage }, token }),

  getStateOverview: () => apiRequest('/state/overview', { token: Session.getAdminToken() }),

  listStations: () => apiRequest('/stations', { token: Session.getAdminToken() }),
  addStation: (payload) => apiRequest('/stations', { method: 'POST', body: payload, token: Session.getAdminToken() }),
  updateStationCredentials: (code, payload) =>
    apiRequest(`/stations/${encodeURIComponent(code)}/credentials`, { method: 'PUT', body: payload, token: Session.getAdminToken() }),
  addTransformer: (code, name) =>
    apiRequest(`/stations/${encodeURIComponent(code)}/transformers`, { method: 'POST', body: { name }, token: Session.getAdminToken() }),
  deleteTransformer: (code, name) =>
    apiRequest(`/stations/${encodeURIComponent(code)}/transformers/${encodeURIComponent(name)}`, { method: 'DELETE', token: Session.getAdminToken() }),
  deleteStation: (code) =>
    apiRequest(`/stations/${encodeURIComponent(code)}`, { method: 'DELETE', token: Session.getAdminToken() })
};

/** Guard helper: redirect to login if the required session is missing. */
function requireStationSession() {
  if (!Session.getStationToken()) window.location.href = 'station-login.html';
}
function requireAdminSession() {
  if (!Session.getAdminToken()) window.location.href = 'state-login.html';
}

function formatCurrency(n) {
  return '\u20b9' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
