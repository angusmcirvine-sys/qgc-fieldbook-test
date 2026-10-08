const XERO_AUTHORIZE = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN = 'https://identity.xero.com/connect/token';
const XERO_API = 'https://api.xero.com/api.xro/2.0';
const XERO_CONNECTIONS = 'https://api.xero.com/connections';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return corsResponse(request, env, '', 204);

    try {
      if (url.pathname === '/connect') return connect(env);
      if (url.pathname === '/callback') return callback(request, env);
      if (url.pathname === '/api/status') {
        const connection = await env.XERO_STORE.get('xero:connection', 'json');
        return json(request, env, {
          connected: !!connection,
          tenantName: connection?.tenantName || null,
          shortCode: connection?.shortCode || null
        });
      }
      if (url.pathname === '/api/create-draft' && request.method === 'POST') {
        return createDraft(request, env);
      }
      if (url.pathname === '/health') return json(request, env, { ok: true });
      return new Response('QGC Xero Bridge', { status: 200 });
    } catch (err) {
      return json(request, env, { error: err?.message || String(err) }, err?.status || 500);
    }
  }
};

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.FRONTEND_ORIGIN || 'https://angusmcirvine-sys.github.io';
  return origin === allowed ? origin : allowed;
}

function corsResponse(request, env, body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin': allowedOrigin(request, env),
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      ...headers
    }
  });
}

function json(request, env, data, status = 200) {
  return corsResponse(request, env, JSON.stringify(data), status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
}

async function connect(env) {
  const state = crypto.randomUUID();
  await env.XERO_STORE.put('oauth:state:' + state, '1', { expirationTtl: 600 });
  const scopes = [
    'openid',
    'profile',
    'email',
    'offline_access',
    'accounting.transactions',
    'accounting.contacts',
    'accounting.settings'
  ].join(' ');

  const u = new URL(XERO_AUTHORIZE);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', env.XERO_CLIENT_ID);
  u.searchParams.set('redirect_uri', env.XERO_REDIRECT_URI);
  u.searchParams.set('scope', scopes);
  u.searchParams.set('state', state);
  return Response.redirect(u.toString(), 302);
}

async function callback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new Error('Missing Xero OAuth callback parameters.');

  const stateKey = 'oauth:state:' + state;
  const validState = await env.XERO_STORE.get(stateKey);
  if (!validState) {
    const e = new Error('OAuth state expired or invalid. Start the Xero connection again.');
    e.status = 400;
    throw e;
  }
  await env.XERO_STORE.delete(stateKey);

  const token = await exchangeToken(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.XERO_REDIRECT_URI
  });
  await storeToken(env, token);

  const connectionsResp = await fetch(XERO_CONNECTIONS, {
    headers: { Authorization: 'Bearer ' + token.access_token, Accept: 'application/json' }
  });
  if (!connectionsResp.ok) throw new Error('Could not read Xero connections: ' + await connectionsResp.text());
  const connections = await connectionsResp.json();
  const tenant = connections.find(x => x.tenantType === 'ORGANISATION') || connections[0];
  if (!tenant) throw new Error('No Xero organisation was connected.');

  const orgResp = await fetch(XERO_API + '/Organisation', {
    headers: xeroHeaders(token.access_token, tenant.tenantId)
  });
  if (!orgResp.ok) throw new Error('Could not read Xero organisation: ' + await orgResp.text());
  const orgData = await orgResp.json();
  const org = orgData.Organisations?.[0] || {};

  const connection = {
    tenantId: tenant.tenantId,
    tenantName: tenant.tenantName || org.Name || '',
    shortCode: org.ShortCode || ''
  };
  await env.XERO_STORE.put('xero:connection', JSON.stringify(connection));

  return Response.redirect(env.FRONTEND_URL || 'https://angusmcirvine-sys.github.io/qgc-fieldbook-test/xero/?connected=1', 302);
}

async function exchangeToken(env, fields) {
  const body = new URLSearchParams(fields);
  const basic = btoa(env.XERO_CLIENT_ID + ':' + env.XERO_CLIENT_SECRET);
  const r = await fetch(XERO_TOKEN, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body
  });
  if (!r.ok) throw new Error('Xero token request failed: ' + await r.text());
  return r.json();
}

async function storeToken(env, token) {
  const record = {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: Date.now() + ((token.expires_in || 1800) * 1000)
  };
  await env.XERO_STORE.put('xero:token', JSON.stringify(record));
  return record;
}

async function accessToken(env) {
  let token = await env.XERO_STORE.get('xero:token', 'json');
  if (!token) {
    const e = new Error('Xero is not connected. Use Connect Xero first.');
    e.status = 401;
    throw e;
  }
  if (token.expires_at > Date.now() + 60000) return token.access_token;
  if (!token.refresh_token) {
    const e = new Error('Xero connection needs to be renewed.');
    e.status = 401;
    throw e;
  }
  const refreshed = await exchangeToken(env, {
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token
  });
  token = await storeToken(env, refreshed);
  return token.access_token;
}

function xeroHeaders(token, tenantId) {
  return {
    Authorization: 'Bearer ' + token,
    'xero-tenant-id': tenantId,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
}

function normalizeAddress(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\bnew zealand\b/g, '')
    .replace(/\bnz\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function streetPart(value) {
  return normalizeAddress(String(value || '').split(',')[0]);
}

function contactAddressStrings(contact) {
  const out = [];
  for (const a of contact.Addresses || []) {
    const parts = [
      a.AddressLine1, a.AddressLine2, a.AddressLine3, a.AddressLine4,
      a.City, a.Region, a.PostalCode, a.Country
    ].filter(Boolean);
    out.push({
      full: normalizeAddress(parts.join(', ')),
      street: normalizeAddress(a.AddressLine1 || ''),
      display: parts.join(', ')
    });
  }
  return out;
}

async function resolveContactByAddress(env, token, tenantId, siteAddress) {
  const target = normalizeAddress(siteAddress);
  const targetStreet = streetPart(siteAddress);
  if (!targetStreet) return null;

  const mapKey = 'addrmap:' + target.slice(0, 300);
  const cached = await env.XERO_STORE.get(mapKey, 'json');
  if (cached?.contactId) return cached;

  const exact = new Map();
  const street = new Map();

  for (let page = 1; page <= 50; page++) {
    const r = await fetch(XERO_API + '/Contacts?page=' + page + '&includeArchived=false', {
      headers: xeroHeaders(token, tenantId)
    });
    if (!r.ok) throw new Error('Could not search Xero contacts: ' + await r.text());
    const data = await r.json();
    const contacts = data.Contacts || [];
    if (!contacts.length) break;

    for (const contact of contacts) {
      for (const a of contactAddressStrings(contact)) {
        const item = {
          contactId: contact.ContactID,
          name: contact.Name || '',
          address: a.display
        };
        if (a.full && a.full === target) exact.set(contact.ContactID, item);
        if (a.street && a.street === targetStreet) street.set(contact.ContactID, item);
      }
    }
    if (contacts.length < 100) break;
  }

  let matches = [...exact.values()];
  if (matches.length !== 1) matches = [...street.values()];

  if (matches.length === 1) {
    await env.XERO_STORE.put(mapKey, JSON.stringify(matches[0]));
    return matches[0];
  }
  if (matches.length > 1) {
    const e = new Error('More than one Xero contact matches this address. Resolve the duplicate address in Xero before sending.');
    e.status = 409;
    throw e;
  }
  return null;
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function pricedLine(env, description, quantity, unitAmount) {
  const line = {
    Description: description,
    Quantity: +n(quantity).toFixed(4),
    UnitAmount: +n(unitAmount).toFixed(2)
  };
  if (env.SALES_ACCOUNT_CODE) line.AccountCode = env.SALES_ACCOUNT_CODE;
  return line;
}

function buildLineItems(env, p) {
  const items = [];
  const description = String(p.description || '').trim().slice(0, 3900);
  items.push({ Description: 'Work completed:\n' + description });

  const labourHours = Math.max(0, n(p.labourHours));
  if (labourHours) items.push(pricedLine(env, 'Labour', labourHours, 65));

  const wasteRunHours = Math.max(0, n(p.wasteRunHours));
  if (wasteRunHours) items.push(pricedLine(env, 'Green waste run', wasteRunHours, 65));

  const waste = String(p.waste || 'none');
  if (waste !== 'none') {
    let fee = 0;
    if (waste === 'small') fee = 37;
    if (waste === 'medium') fee = 74;
    if (waste === 'large') fee = n(env.WASTE_LARGE_RATE);
    const label = waste === 'small'
      ? 'Green waste disposal ≤100kg'
      : waste === 'medium'
        ? 'Green waste disposal 100–200kg'
        : 'Green waste disposal 200kg+';
    items.push(pricedLine(env, fee ? label : label + ' — fee to confirm', 1, fee));
  }

  const dumpKm = Math.max(0, n(p.dumpKm));
  if (dumpKm) items.push(pricedLine(env, 'Dump travel', dumpKm, 2));

  const ride = Math.max(0, n(p.rideOnHours));
  if (ride) items.push(pricedLine(env, 'Ride-on mower', ride, 95));

  const spray = Math.max(0, n(p.spray15L));
  if (spray) items.push(pricedLine(env, 'Spray application (15L)', spray, 16));

  return items;
}

async function createDraft(request, env) {
  const p = await request.json();
  const siteAddress = String(p.siteAddress || '').trim();
  if (!siteAddress) return json(request, env, { error: 'Site address is required.' }, 400);
  if (!String(p.description || '').trim()) return json(request, env, { error: 'Completed-work description is required.' }, 400);

  const connection = await env.XERO_STORE.get('xero:connection', 'json');
  if (!connection?.tenantId) return json(request, env, { error: 'Xero is not connected.' }, 401);

  const token = await accessToken(env);
  const contact = await resolveContactByAddress(env, token, connection.tenantId, siteAddress);
  if (!contact) {
    return json(request, env, {
      error: 'No Xero contact matched this property address: ' + siteAddress
    }, 404);
  }

  const invoice = {
    Type: 'ACCREC',
    Contact: { ContactID: contact.contactId },
    Date: p.date || new Date().toISOString().slice(0, 10),
    Status: 'DRAFT',
    Reference: siteAddress.slice(0, 255),
    LineAmountTypes: 'Exclusive',
    LineItems: buildLineItems(env, p)
  };

  const r = await fetch(XERO_API + '/Invoices?unitdp=4', {
    method: 'POST',
    headers: xeroHeaders(token, connection.tenantId),
    body: JSON.stringify({ Invoices: [invoice] })
  });
  const raw = await r.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {}
  if (!r.ok) {
    const e = new Error('Xero invoice creation failed: ' + (data?.Message || raw));
    e.status = r.status;
    throw e;
  }

  const created = data.Invoices?.[0];
  if (!created?.InvoiceID) throw new Error('Xero created the invoice but did not return an InvoiceID.');

  const redirect = '/AccountsReceivable/View.aspx?InvoiceID=' + created.InvoiceID;
  const deepLink =
    'https://go.xero.com/organisationlogin/default.aspx?shortcode=' +
    encodeURIComponent(connection.shortCode || '') +
    '&redirecturl=' + encodeURIComponent(redirect);

  return json(request, env, {
    ok: true,
    invoiceId: created.InvoiceID,
    invoiceNumber: created.InvoiceNumber || null,
    contactName: contact.name,
    siteAddress,
    deepLink
  });
}
