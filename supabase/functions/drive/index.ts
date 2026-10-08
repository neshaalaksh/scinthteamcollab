// The "drive" function: puts uploaded files in Google Drive and lists them in drive_files.
// In Drive, each space has its own folder inside DRIVE_FOLDER_ID, and each folder made in a
// space is a folder inside that.
//
//   POST multipart/form-data { file, space, folder }   -> uploads, returns the new drive_files row
//   POST application/json { action: 'update', id, name?, space?, folder? }
//                                                      -> renames and/or moves (uploader or admin only)
//   POST application/json { action: 'delete', id }    -> deletes (uploader or admin only)
//   POST application/json { action: 'organize' }       -> owner/admins: moves files uploaded before
//                                                         space folders existed into them, a batch at a time
//
// It acts as the signed-in person for the database, so the same security rules apply as
// everywhere else (who may see a space, who may delete a file). Only the Google Drive calls
// use the function's own Google credentials. Setup: SETUP.md, "Drive".

import { createClient } from 'npm:@supabase/supabase-js@2';
import { uploadFile, deleteFile, folderFor, updateFile } from './google.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// A folder name: one level, so no slashes. '' = straight in the space.
const cleanFolder = (v: unknown) => String(v ?? '').replace(/[\/\\]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100);

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
      const folder = cleanFolder(form.get('folder'));
      if (!(file instanceof File) || !file.name) return reply({ error: 'Pick a file to upload.' }, 400);
      const maxMb = Number(env.DRIVE_MAX_MB) || 20;
      if (file.size > maxMb * 1024 * 1024) return reply({ error: `That file is over ${maxMb} MB. Upload it to Google Drive directly and share the link instead.` }, 413);

      // Check the space first (the database only shows spaces you may see), so nothing reaches Drive otherwise.
      const { data: sp } = await sb.from('spaces').select('id, name').eq('id', space).maybeSingle();
      if (!sp) return reply({ error: 'You cannot upload to that space.' }, 403);

      const name = file.name.slice(0, 255);
      const mime = file.type || 'application/octet-stream';
      const parent = await folderFor(env, { space, spaceName: sp.name, folder });
      const g = await uploadFile(env, { name, mime, parent, bytes: new Uint8Array(await file.arrayBuffer()) });
      const { data: row, error } = await sb.from('drive_files')
        .insert({ name, drive_id: g.id, url: g.url, mime, size: file.size, space, folder, drive_folder: parent })
        .select().single();
      if (error) {
        await deleteFile(env, g.id).catch(() => {});   // don't leave a file nobody can see
        return reply({ error: /row-level security/i.test(error.message) ? 'You cannot upload to that space.' : error.message }, 403);
      }
      return reply(row);
    }

    const body = await req.json().catch(() => ({}));
    const me = (who.user.email ?? '').toLowerCase();
    const isAdmin = async () => {
      const { data } = await sb.from('team').select('role').eq('email', me).maybeSingle();
      return data?.role === 'owner' || data?.role === 'admin';
    };

    // ---- rename and/or move
    if (body?.action === 'update' && body.id) {
      const { data: row } = await sb.from('drive_files').select('*').eq('id', String(body.id)).maybeSingle();
      if (!row) return reply({ error: 'That file is gone. Refresh the page.' }, 404);
      // Checked here so nothing changes in Drive for someone who may not; the database checks again.
      if (row.uploaded_by !== me && !(await isAdmin())) {
        return reply({ error: 'Only admins, or the person who uploaded it, can rename or move this.' }, 403);
      }
      const name = body.name === undefined ? row.name : String(body.name).trim().slice(0, 255);
      if (!name) return reply({ error: 'A file needs a name.' }, 400);
      const space = body.space === undefined ? row.space : String(body.space || 'scinth');
      const folder = body.folder === undefined ? row.folder : cleanFolder(body.folder);
      const { data: sp } = await sb.from('spaces').select('id, name').eq('id', space).maybeSingle();
      if (!sp) return reply({ error: 'You cannot move files to that space.' }, 403);

      const to = await folderFor(env, { space, spaceName: sp.name, folder });
      const before = await updateFile(env, row.drive_id, { name, to });
      const { data: saved, error } = await sb.from('drive_files')
        .update({ name, space, folder, drive_folder: to }).eq('id', row.id).select();
      if (error || !saved?.length) {
        // Put it back in Drive the way it was, so Drive and the list still agree.
        await updateFile(env, row.drive_id, { name: before.name, to: before.parents?.[0] }).catch(() => {});
        return reply({ error: error && !/row-level security/i.test(error.message) ? error.message : 'You cannot move files to that space.' }, 403);
      }
      return reply(saved[0]);
    }

    // ---- sort files uploaded before space folders existed (owner and admins)
    if (body?.action === 'organize') {
      if (!(await isAdmin())) return reply({ error: 'Only the owner and admins can sort the Drive folder.' }, 403);
      const { data: rows, error } = await sb.from('drive_files').select('id, drive_id, space, folder')
        .is('drive_folder', null).order('uploaded_at').limit(20);
      if (error) return reply({ error: error.message }, 400);
      const { data: spaces } = await sb.from('spaces').select('id, name');
      const names = new Map((spaces ?? []).map((s) => [s.id, s.name]));
      const cache = new Map();
      let sorted = 0;
      const failed: string[] = [];
      for (const f of rows ?? []) {
        try {
          const to = await folderFor(env, { space: f.space, spaceName: names.get(f.space), folder: f.folder }, fetch, cache);
          await updateFile(env, f.drive_id, { to });
          const { error: e } = await sb.from('drive_files').update({ drive_folder: to }).eq('id', f.id);
          if (e) throw e;
          sorted++;
        } catch (err) {
          console.error('Could not sort', f.id, err);
          failed.push(f.id);
        }
      }
      const { count } = await sb.from('drive_files').select('id', { count: 'exact', head: true }).is('drive_folder', null);
      return reply({ sorted, failed, left: count ?? 0 });
    }

    // ---- delete
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
