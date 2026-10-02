// Turns links into embeds. Any link on a line by itself in a doc, task
// description or daily update becomes a live embed if we recognise it.

const GOOGLE = 'docs.google.com';

export function toEmbed(rawUrl) {
  let u;
  try { u = new URL(rawUrl.trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname;
  let m;

  if (host === GOOGLE) {
    // Published to web: /spreadsheets/d/e/<id>/pubhtml (always read-only, works for anyone)
    if ((m = path.match(/^\/spreadsheets\/d\/e\/([\w-]+)/))) {
      const gid = u.searchParams.get('gid');
      return embed('sheet', 'Google Sheet',
        `https://docs.google.com/spreadsheets/d/e/${m[1]}/pubhtml?widget=true&headers=false${gid ? `&gid=${gid}` : ''}`, rawUrl);
    }
    if ((m = path.match(/^\/spreadsheets\/d\/([\w-]+)(\/[\w]+)?/))) {
      const id = m[1];
      const gid = (u.hash.match(/gid=(\d+)/) || [])[1] || u.searchParams.get('gid');
      const readOnly = m[2] === '/preview' || m[2] === '/htmlview';
      const base = `https://docs.google.com/spreadsheets/d/${id}`;
      const src = readOnly
        ? `${base}/preview${gid ? `#gid=${gid}` : ''}`
        : `${base}/edit?rm=minimal${gid ? `#gid=${gid}` : ''}`;
      return embed('sheet', readOnly ? 'Google Sheet (view only)' : 'Google Sheet', src, `${base}/edit${gid ? `#gid=${gid}` : ''}`);
    }
    if ((m = path.match(/^\/document\/d\/(e\/)?([\w-]+)(\/[\w]+)?/))) {
      if (m[1]) return embed('doc', 'Google Doc', `https://docs.google.com/document/d/e/${m[2]}/pub?embedded=true`, rawUrl);
      const readOnly = m[3] === '/preview';
      const base = `https://docs.google.com/document/d/${m[2]}`;
      return embed('doc', 'Google Doc', readOnly ? `${base}/preview` : `${base}/edit?rm=minimal`, `${base}/edit`);
    }
    if ((m = path.match(/^\/presentation\/d\/(e\/)?([\w-]+)/))) {
      const base = `https://docs.google.com/presentation/d/${m[1] || ''}${m[2]}`;
      return embed('slides', 'Google Slides', `${base}/embed?start=false&loop=false`, rawUrl);
    }
    if ((m = path.match(/^\/forms\/d\/e\/([\w-]+)/))) {
      return embed('form', 'Google Form', `https://docs.google.com/forms/d/e/${m[1]}/viewform?embedded=true`, rawUrl);
    }
  }
  if (host === 'drive.google.com' && (m = path.match(/^\/file\/d\/([\w-]+)/))) {
    return embed('file', 'Drive file', `https://drive.google.com/file/d/${m[1]}/preview`, rawUrl);
  }
  if (host === 'calendar.google.com' && path.startsWith('/calendar/embed')) {
    return embed('calendar', 'Google Calendar', u.href, rawUrl);
  }
  if (host === 'lookerstudio.google.com' && (m = path.match(/\/reporting\/([\w-]+)/))) {
    return embed('chart', 'Looker Studio', `https://lookerstudio.google.com/embed/reporting/${m[1]}`, rawUrl);
  }
  if ((host === 'youtube.com' || host === 'm.youtube.com') && u.searchParams.get('v')) {
    return embed('video', 'YouTube', `https://www.youtube-nocookie.com/embed/${u.searchParams.get('v')}`, rawUrl, 'video');
  }
  if (host === 'youtu.be' && path.length > 1) {
    return embed('video', 'YouTube', `https://www.youtube-nocookie.com/embed${path}`, rawUrl, 'video');
  }
  if (host === 'loom.com' && (m = path.match(/^\/share\/([\w]+)/))) {
    return embed('video', 'Loom', `https://www.loom.com/embed/${m[1]}`, rawUrl, 'video');
  }
  if (host === 'figma.com' && /^\/(file|design|proto|board)\//.test(path)) {
    return embed('design', 'Figma', `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(u.href)}`, rawUrl);
  }
  return null;
}

function embed(kind, label, src, openUrl, shape = 'tall') {
  return { kind, label, src, openUrl, shape };
}

// height: pixels, or 'fill' to let the page decide (Sheets hub).
export function embedHtml(info, height) {
  const h = height || (info.kind === 'sheet' ? 520 : 440);
  const style = info.shape === 'video' || height === 'fill' ? '' : `style="height:${h}px"`;
  return `<figure class="embed embed-${info.kind} ${info.shape} ${height === 'fill' ? 'fill' : ''}">
    <figcaption>
      <span class="embed-kind">${info.label}</span><span class="grow"></span>
      <a href="${escAttr(info.openUrl)}" target="_blank" rel="noopener">Open ↗</a>
    </figcaption>
    <div class="embed-frame" ${style}>
      <iframe src="${escAttr(info.src)}" loading="lazy" allow="clipboard-write; fullscreen" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>
    </div>
  </figure>`;
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
