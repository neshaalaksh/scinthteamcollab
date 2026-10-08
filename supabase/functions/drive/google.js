// Google Drive calls for the "drive" function. Plain JavaScript (no Deno APIs), so it can be
// tested anywhere: pass in the settings and a fetch function.
//
// Two ways to sign in to Google (set one in the function's secrets, see SETUP.md):
//   * GOOGLE_REFRESH_TOKEN + GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET:
//     files are uploaded as that Google account (works with a normal Gmail account).
//   * GOOGLE_SERVICE_ACCOUNT (the JSON key): files go into a Shared drive the service
//     account is a member of (service accounts have no storage of their own).

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const enc = (s) => new TextEncoder().encode(s);

function b64url(bytes) {
  const arr = typeof bytes === 'string' ? enc(bytes) : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i += 0x8000) s += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function googleError(res, what) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message || [j?.error, j?.error_description].filter((v) => typeof v === 'string').join(': ');
  } catch { /* not JSON */ }
  return new Error(`Google Drive ${what} failed (${res.status})${detail ? `: ${detail}` : ''}`);
}

// A short-lived access token for the Drive API.
export async function accessToken(env, fetchFn = fetch) {
  let body;
  if (env.GOOGLE_REFRESH_TOKEN) {
    body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID || '',
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    });
  } else if (env.GOOGLE_SERVICE_ACCOUNT) {
    const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive', aud: TOKEN_URL, iat: now, exp: now + 3600,
    }));
    const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc(`${head}.${claim}`));
    body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${b64url(sig)}` });
  } else {
    throw new Error('Drive is not set up yet: add the Google secrets to the "drive" function (see SETUP.md).');
  }
  const res = await fetchFn(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!res.ok) throw await googleError(res, 'sign-in');
  return (await res.json()).access_token;
}

// Uploads bytes into the folder. Returns { id, url }.
// Uses a resumable upload, which works for files of any size (multipart is capped at 5 MB).
export async function uploadFile(env, { name, mime, bytes }, fetchFn = fetch) {
  if (!env.DRIVE_FOLDER_ID) throw new Error('Drive is not set up yet: add DRIVE_FOLDER_ID to the "drive" function (see SETUP.md).');
  const token = await accessToken(env, fetchFn);
  const auth = { Authorization: `Bearer ${token}` };
  const start = await fetchFn(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=id,webViewLink`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime || 'application/octet-stream' },
    body: JSON.stringify({ name, parents: [env.DRIVE_FOLDER_ID] }),
  });
  if (!start.ok) throw await googleError(start, 'upload');
  const session = start.headers.get('Location');
  if (!session) throw new Error('Google Drive upload failed: no upload address came back.');
  const put = await fetchFn(session, { method: 'PUT', headers: { 'Content-Type': mime || 'application/octet-stream' }, body: bytes });
  if (!put.ok) throw await googleError(put, 'upload');
  const file = await put.json();

  // Let clients open it: by default anyone with the link can view (DRIVE_LINK_SHARING=anyone).
  // Set DRIVE_LINK_SHARING=folder to rely on the folder's own sharing instead.
  if ((env.DRIVE_LINK_SHARING || 'anyone') === 'anyone') {
    const perm = await fetchFn(`${DRIVE}/files/${encodeURIComponent(file.id)}/permissions?supportsAllDrives=true`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
    if (!perm.ok) {
      await deleteFile(env, file.id, fetchFn).catch(() => {});
      throw await googleError(perm, 'sharing');
    }
  }
  return { id: file.id, url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view` };
}

// Deletes the file from Drive. A file that is already gone counts as deleted.
export async function deleteFile(env, id, fetchFn = fetch) {
  const token = await accessToken(env, fetchFn);
  const res = await fetchFn(`${DRIVE}/files/${encodeURIComponent(id)}?supportsAllDrives=true`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw await googleError(res, 'delete');
}
