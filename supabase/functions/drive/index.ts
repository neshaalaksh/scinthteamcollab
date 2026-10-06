// The "drive" function: puts uploaded files in Google Drive and lists them in drive_files.
//
//   POST multipart/form-data { file, space }   -> uploads, returns the new drive_files row
//   POST application/json { action: 'delete', id }   -> deletes (uploader or admin only)
//
// It acts as the signed-in person for the database, so the same security rules apply as
// everywhere else (who may see a space, who may delete a file). Only the Google Drive calls
// use the function's own Google credentials. Setup: SETUP.md, "Drive".

import { createClient } from 'npm:@supabase/supabase-js@2';
import { uploadFile, deleteFile } from './google.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply({ error: 'Use POST.' }, 405);

  const env = Deno.env.toObject();
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false },
  });
  const { data: who } = await sb.auth.getUser();
  if (!who?.user) return reply({ error: 'Your sign-in expired. Please sign in again.' }, 401);

  try {
    const type = req.headers.get('Content-Type') ?? '';

    // ---- upload
    if (type.startsWith('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      const space = String(form.get('space') || 'scinth');
      if (!(file instanceof File) || !file.name) return reply({ error: 'Pick a file to upload.' }, 400);
      const maxMb = Number(env.DRIVE_MAX_MB) || 20;
      if (file.size > maxMb * 1024 * 1024) return reply({ error: `That file is over ${maxMb} MB. Upload it to Google Drive directly and share the link instead.` }, 413);

      // Check the space first (the database only shows spaces you may see), so nothing reaches Drive otherwise.
      const { data: sp } = await sb.from('spaces').select('id').eq('id', space).maybeSingle();
      if (!sp) return reply({ error: 'You cannot upload to that space.' }, 403);

      const name = file.name.slice(0, 255);
      const mime = file.type || 'application/octet-stream';
      const g = await uploadFile(env, { name, mime, bytes: new Uint8Array(await file.arrayBuffer()) });
      const { data: row, error } = await sb.from('drive_files')
        .insert({ name, drive_id: g.id, url: g.url, mime, size: file.size, space })
        .select().single();
      if (error) {
        await deleteFile(env, g.id).catch(() => {});   // don't leave a file nobody can see
        return reply({ error: /row-level security/i.test(error.message) ? 'You cannot upload to that space.' : error.message }, 403);
      }
      return reply(row);
    }

    // ---- delete
    const body = await req.json().catch(() => ({}));
    if (body?.action === 'delete' && body.id) {
      // Deleting the row first applies the rules (uploader or admin); only then remove it from Drive.
      const { data: gone, error } = await sb.from('drive_files').delete().eq('id', String(body.id)).select('id, drive_id');
      if (error) return reply({ error: error.message }, 400);
      if (!gone?.length) return reply({ error: 'Only admins, or the person who uploaded it, can delete this.' }, 403);
      try {
        await deleteFile(env, gone[0].drive_id);
      } catch (err) {
        console.error('Removed from the list but not from Drive:', gone[0].drive_id, err);
      }
      return reply({ id: gone[0].id });
    }
    return reply({ error: 'Unknown request.' }, 400);
  } catch (err) {
    console.error(err);
    return reply({ error: err instanceof Error ? err.message : 'Something went wrong.' }, 500);
  }
});
