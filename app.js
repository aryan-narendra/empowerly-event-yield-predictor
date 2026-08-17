/* UI layer. All computation is local; nothing leaves the browser. */

const $ = (id) => document.getElementById(id);
const state = {
  model: null, rows: [], families: [], fileName: '', detected: null,
  trainError: null, venue: null, venueText: '', trainRows: null, refining: false,
  declinedAutoSet: false,
};

const PINE = '#2c6b57', PINE_SOFT = '#b8d3c7', BRASS_SOFT = '#e3d6ad', INK = '#16262a';
const BRICK = '#9c4a3b', BRASS = '#8d7028', MUTED_GREEN = '#a9bdb0', MUTED_BRASS = '#cfc4a4';
const PARTY_COLORS = ['#9fb3a6', '#2c6b57', '#3a5a6e', '#8d7028', '#9c4a3b', '#6b5b8e'];
const SRC_COLORS = ['#2c6b57', '#3a5a6e', '#8d7028', '#9c4a3b', '#5a7f6d', '#6b5b8e', '#3f7d86', '#a06a35'];
const NO_SOURCE = '#aab3ad';

/* ---------- file reading ---------- */

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    if (/\.xlsx?$/i.test(file.name)) {
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          resolve(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false }));
        } catch (err) { reject(new Error(`${file.name} is not a readable Excel file.`)); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = (e) => {
        const out = Papa.parse(e.target.result, { header: true, skipEmptyLines: true });
        resolve(out.data);
      };
      reader.readAsText(file);
    }
  });
}

/* ---------- training data ---------- */

const parseCsvText = (text) => Papa.parse(text.trim(), { header: true, skipEmptyLines: true }).data;

const parseSheet = (buffer) => {
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
};

/** Local calendar date (YYYY-MM-DD) for a UTC timestamp, in the given zone. */
function localDate(ms, tz) {
  const probe = new Date(ms);
  const offset = TZ_OFFSET[tz] + (dstActive(tz, probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate()) ? 1 : 0);
  const local = new Date(ms + offset * 3600000);
  return local.toISOString().slice(0, 10);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Where the past events come from. On GitHub Pages the training folder is read
 * straight from the repo, so a finished export dropped in there is picked up on
 * the next load. Everywhere else (and if the API is rate limited) the manifest
 * lists the files, since a static host can't be asked what's in a folder.
 *
 * The manifest is also the only place venue coordinates can come from, so an
 * event discovered through the folder listing alone trains lead time and group
 * booking but contributes nothing to the distance term.
 */
async function discoverTraining() {
  const entries = new Map();

  try {
    const manifest = await fetch('training/manifest.json').then((r) => (r.ok ? r.json() : null));
    for (const e of (manifest && manifest.events) || []) if (e.file) entries.set(e.file, { ...e });
  } catch (err) { /* no manifest is fine when the API can list the folder */ }

  const host = location.hostname;
  if (host.endsWith('github.io')) {
    const owner = host.split('.')[0];
    const seg = location.pathname.split('/').filter(Boolean);
    const repo = seg.length ? seg[0] : `${owner}.github.io`;
    try {
      const listing = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/training`)
        .then((r) => (r.ok ? r.json() : null));
      for (const item of listing || []) {
        if (item.type !== 'file' || !/\.(csv|xlsx|xls)$/i.test(item.name)) continue;
        if (!entries.has(item.name)) entries.set(item.name, { file: item.name });
      }
    } catch (err) { /* fall back to whatever the manifest gave us */ }
  }

  return [...entries.values()];
}

/** Read one past event. Raw Luma exports and anonymized files both work. */
async function loadPastEvent(entry) {
  const url = `training/${entry.file}`;
  let rows;
  if (/\.xlsx?$/i.test(entry.file)) {
    const buf = await fetch(url).then((r) => { if (!r.ok) throw new Error(`${url} not found`); return r.arrayBuffer(); });
    rows = parseSheet(buf);
  } else {
    const text = await fetch(url).then((r) => { if (!r.ok) throw new Error(`${url} not found`); return r.text(); });
    rows = parseCsvText(text);
  }
  if (!rows.length) throw new Error(`${entry.file} is empty`);

  const label = entry.label || entry.file.replace(/\.[^.]+$/, '');

  // Already-summarized file: no personal data, nothing to work out.
  if ('lead_days' in rows[0] && 'tickets' in rows[0]) {
    const out = [];
    for (const r of rows) {
      const tickets = Number(r.tickets);
      if (!Number.isFinite(tickets)) continue;
      out.push({
        eventId: r.event_id || label,
        region: r.region || 'West',
        tickets,
        leadDays: Number(r.lead_days),
        attended: Number(r.attended) ? 1 : 0,
        ticketsChecked: Number(r.tickets_checked || 0),
        isGroup: tickets > 1 ? 1 : 0,
        status: Number(r.cancelled) ? 'cancelled' : 'approved',
        zip: '',
        miles: null,          // anonymized files strip ZIPs, so no distance
      });
    }
    return { label, rows: out, date: entry.date || null, tz: entry.tz || null, venue: null };
  }

  if (!('created_at' in rows[0])) throw new Error(`${entry.file} has no created_at column`);

  const tz = entry.tz || detectTz(rows).tz;
  const checkIns = rows.map((r) => Date.parse(r.checked_in_at)).filter(Number.isFinite);
  if (!checkIns.length) throw new Error(`${entry.file} has no check-ins, so it can't teach the model who showed up`);

  // Event date: whatever the manifest says, else the date in the filename,
  // else the evening the guests were actually scanned in.
  const fromName = (entry.file.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
  const date = entry.date || fromName || localDate(median(checkIns), tz);
  const startMs = eventStartMs(date, tz);
  const region = entry.region || regionForTz(tz);

  /* Venue: explicit coordinates win, then the free-text venue field. Without
     either, this event simply sits out of the distance term. */
  const venue = (Number.isFinite(entry.lat) && Number.isFinite(entry.lon))
    ? [entry.lat, entry.lon]
    : resolveVenue(entry.venue);

  const out = buildFamilies(rows, startMs).map((fam) => ({
    eventId: label,
    region,
    tickets: fam.tickets,
    leadDays: fam.leadDays,
    attended: fam.checkedIn > 0 ? 1 : 0,
    ticketsChecked: fam.checkedIn,
    isGroup: fam.isGroup,
    status: fam.status,
    zip: fam.zip,
    miles: familyMiles(fam, venue),
  }));
  return { label, rows: out, date, tz, region, venue, venueText: entry.venue || null };
}

function decorateModel(model, loaded, skipped) {
  model.loaded = loaded.map((e) => ({
    label: e.label, date: e.date, n: e.rows.length, region: e.region,
    venueText: e.venueText || null, hasVenue: !!e.venue,
    withMiles: e.rows.filter((r) => r.miles != null).length,
  }));
  model.skipped = skipped;
  return model;
}

async function loadTraining() {
  const entries = await discoverTraining();
  if (!entries.length) throw new Error('No past events found in the training folder.');

  const loaded = [];
  const skipped = [];
  const results = await Promise.all(entries.map((e) => loadPastEvent(e).catch((err) => ({ error: err.message }))));
  for (const res of results) {
    if (res.error) skipped.push(res.error);
    else if (!res.rows.length) skipped.push(`${res.label} had no usable rows`);
    else loaded.push(res);
  }
  const rows = loaded.flatMap((e) => e.rows);
  if (rows.length < 12) {
    throw new Error(`Only ${rows.length} past families could be read, which is too few to fit a model.`);
  }

  /* Two passes. The first holds the two tuning constants fixed and lands in a
     few milliseconds, so the page paints straight away even on an old machine.
     The second searches both by leave-one-event-out, which is nearly all of the
     work, and swaps in only if it actually lands somewhere different. */
  state.trainRows = rows;
  state.loadedMeta = { loaded, skipped };
  return decorateModel(
    buildModel(rows, { lambda: DEFAULT_LAMBDA, distK: DEFAULT_DIST_K, bootstrap: 12 }),
    loaded, skipped,
  );
}

/** Background pass: search the shape penalty and the distance constant. */
function refineModel() {
  if (state.refining || !state.trainRows || !state.loadedMeta) return;
  state.refining = true;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 60));
  idle(() => {
    try {
      const better = buildModel(state.trainRows);
      /* Always swap in: even when the two tuning constants land where the
         quick fit put them, the background pass carries five times as many
         resamples, so the uncertainty band is smoother. */
      if (!better) return;
      state.model = decorateModel(better, state.loadedMeta.loaded, state.loadedMeta.skipped);
      render();
    } catch (err) { /* the quick fit stands */ }
  });
}

/* ---------- charts ---------- */

const svgEl = (tag, attrs) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
};

/**
 * The signature view: the histogram of simulated outcomes, with two rules beneath it.
 * The inner rule is the spread you would get if the model were exactly right;
 * the outer rule adds the fact that it was fitted on a handful of past events.
 */
function drawDistribution(host, sim, level, key, actual) {
  const W = 420, padX = 8, top = 20, plotH = 86, ruleY = plotH + 46;
  const H = Number.isFinite(actual) ? 200 : 186;
  const full = sim.full[key], outcome = sim.outcomeOnly[key];
  const outer = interval(full, level), inner = interval(outcome, level);
  const showActual = Number.isFinite(actual);
  /* The domain stretches to take in the real outcome, so a night that landed
     outside the forecast is visible rather than clipped off the edge. */
  const lo = Math.max(0, Math.min(...full, showActual ? actual : Infinity) - 1);
  const hi = Math.max(...full, showActual ? actual : -Infinity) + 1;
  const span = Math.max(hi - lo, 1);
  const x = (v) => padX + ((v - lo) / span) * (W - padX * 2);

  const bins = new Map();
  for (const v of full) bins.set(v, (bins.get(v) || 0) + 1);
  const peak = Math.max(...bins.values());

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  svg.appendChild(svgEl('title', {})).textContent =
    `Simulated ${key === 'people' ? 'attendance' : 'families'}: most likely ${Math.round(outer.median)}, range ${outer.lo} to ${outer.hi}`;

  const barW = Math.max((W - padX * 2) / span - 1, 1.2);
  for (const [v, c] of [...bins].sort((a, b) => a[0] - b[0])) {
    const h = (c / peak) * plotH;
    const inCI = v >= outer.lo && v <= outer.hi;
    svg.appendChild(svgEl('rect', {
      x: x(v) - barW / 2, y: top + plotH - h, width: barW, height: h,
      fill: inCI ? PINE_SOFT : '#dfe5df',
    }));
  }

  svg.appendChild(svgEl('line', {
    x1: x(outer.median), x2: x(outer.median), y1: top - 4, y2: top + plotH,
    stroke: INK, 'stroke-width': 1.6,
  }));
  svg.appendChild(svgEl('line', {
    x1: padX, x2: W - padX, y1: top + plotH, y2: top + plotH, stroke: '#cdd5cc', 'stroke-width': 1,
  }));

  for (const v of [lo, Math.round((lo + hi) / 2), hi]) {
    const t = svgEl('text', {
      x: Math.min(Math.max(x(v), 12), W - 12), y: top + plotH + 14, 'font-size': 10, fill: '#7c8b8f',
      'text-anchor': 'middle', 'font-family': 'IBM Plex Mono, monospace',
    });
    t.textContent = Math.round(v);
    svg.appendChild(t);
  }

  // One band nested inside the other: the wide bar is everything, the bar
  // sitting inside it is the spread you would still get with a perfect model.
  const band = (a, b, color, h, y) => svg.appendChild(svgEl('rect', {
    x: x(a), y, width: Math.max(x(b) - x(a), 2.5), height: h, fill: color, rx: 1.5,
  }));
  band(outer.lo, outer.hi, BRASS_SOFT, 12, ruleY);
  band(inner.lo, inner.hi, PINE_SOFT, 12, ruleY);
  svg.appendChild(svgEl('rect', { x: x(outer.median) - 1, y: ruleY - 3, width: 2, height: 18, fill: INK }));

  /* What actually happened, drawn only for events that have already run. */
  if (showActual) {
    svg.appendChild(svgEl('line', {
      x1: x(actual), x2: x(actual), y1: top - 4, y2: top + plotH,
      stroke: BRICK, 'stroke-width': 2,
    }));
    svg.appendChild(svgEl('rect', {
      x: x(actual) - 1, y: ruleY - 3, width: 2, height: 18, fill: BRICK,
    }));
    const lab = svgEl('text', {
      x: Math.min(Math.max(x(actual), 22), W - 22), y: top - 8,
      'font-size': 10, fill: BRICK, 'text-anchor': 'middle',
      'font-family': 'IBM Plex Mono, monospace', 'font-weight': 600,
    });
    lab.textContent = `actual ${actual}`;
    svg.appendChild(lab);
  }

  const cap = svgEl('text', {
    x: padX, y: ruleY + 32, 'font-size': 9.5, fill: '#52646a', 'font-family': 'IBM Plex Mono, monospace',
  });
  cap.textContent = `${outer.lo}\u2013${outer.hi} all in  \u00b7  ${inner.lo}\u2013${inner.hi} if the model were exact`;
  if (showActual) {
    const miss = actual < outer.lo || actual > outer.hi;
    const cap2 = svgEl('text', {
      x: padX, y: ruleY + 45, 'font-size': 9.5, fill: BRICK, 'font-family': 'IBM Plex Mono, monospace',
    });
    cap2.textContent = `actual ${actual}, ${miss ? 'outside' : 'inside'} the range`;
    svg.appendChild(cap2);
  }
  svg.appendChild(cap);

  host.innerHTML = '';
  host.appendChild(svg);
  return { outer, inner };
}

/**
 * Registrations accumulating as the event approaches. The x axis counts down:
 * the first sign-up on the left, the doors opening at zero on the right.
 *
 * A registration is an instant, so the line steps: flat until the moment
 * someone signs up, then straight up. It stops at the present moment rather
 * than running to the event, and the endpoint carries a dot.
 *
 * Two lines. Green is everyone who registered; brass is the subset whose final
 * status is approved. Luma records no approval timestamp, so the brass line
 * places each approved family at the moment they registered, not the moment
 * they were waved through. It shows composition, not the approval queue.
 */
function drawGrowthChart(host, families, includePending, startMs) {
  host.innerHTML = '';
  const regs = families
    .filter((f) => Number.isFinite(f.leadDays))
    .sort((a, b) => b.leadDays - a.leadDays);
  if (regs.length < 2) return;

  /* Lead days remaining right now. Registration stamps and startMs are both
     UTC, so this needs no zone handling of its own: the zone is already baked
     into startMs by eventStartMs. Past events clamp to the event itself. */
  const nowLead = Math.max((startMs - Date.now()) / 86400000, 0);
  const upcoming = startMs > Date.now();

  const maxLead = Math.max(regs[0].leadDays, 0.001);
  const W = 330, H = 136, padL = 30, padR = 16, top = 10, padB = 24;
  const plotW = W - padL - padR, plotH = H - top - padB;
  const x = (lead) => padL + ((maxLead - Math.min(Math.max(lead, nowLead), maxLead)) / maxLead) * plotW;

  /* Step series: horizontal to the sign-up, then vertical by one. */
  const series = (pred) => {
    const pts = [[x(maxLead), 0]];
    let n = 0;
    for (const f of regs) {
      if (!pred(f)) continue;
      pts.push([x(f.leadDays), n]);
      n += 1;
      pts.push([x(f.leadDays), n]);
    }
    pts.push([x(nowLead), n]);
    return pts;
  };
  const regPts = series(() => true);
  const appPts = series((f) => f.status === 'approved');
  const peak = Math.max(regPts[regPts.length - 1][1], 1);
  const y = (v) => top + plotH - (v / peak) * plotH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  svg.appendChild(svgEl('title', {})).textContent =
    `${peak} families registered over the ${maxLead.toFixed(0)} days before the event`;

  for (let i = 0; i <= 2; i += 1) {
    const v = (peak / 2) * i;
    svg.appendChild(svgEl('line', {
      x1: padL, x2: W - padR, y1: y(v), y2: y(v), stroke: '#e0e5de', 'stroke-width': 1,
    }));
    const lab = svgEl('text', {
      x: padL - 5, y: y(v) + 3, 'font-size': 8.5, fill: '#7c8b8f', 'text-anchor': 'end',
      'font-family': 'IBM Plex Mono, monospace',
    });
    lab.textContent = Math.round(v);
    svg.appendChild(lab);
  }

  const path = (pts) => `M${pts.map(([px, pv]) => `${px.toFixed(1)},${y(pv).toFixed(1)}`).join('L')}`;
  const line = (pts, color, width) => svg.appendChild(svgEl('path', {
    d: path(pts), fill: 'none', stroke: color, 'stroke-width': width,
    'stroke-linejoin': 'miter', 'stroke-linecap': 'butt',
  }));
  /* The endpoint marker. The ring only breathes while the list is still open. */
  const endDot = (pts, color, lead, live) => {
    const cy = y(pts[pts.length - 1][1]);
    if (live && upcoming) {
      const ring = svgEl('circle', { cx: x(lead), cy, r: 3, fill: color });
      ring.setAttribute('class', 'pulse-ring');
      svg.appendChild(ring);
    }
    svg.appendChild(svgEl('circle', {
      cx: x(lead), cy, r: 3, fill: color, stroke: '#fafbf8', 'stroke-width': 1.5,
    }));
  };

  /* Flip this if the emphasis ever wants inverting. */
  const dimGreen = includePending;
  if (dimGreen) {
    line(regPts, MUTED_GREEN, 1.4);
    line(appPts, BRASS, 2);
    endDot(regPts, MUTED_GREEN, nowLead, false);
    endDot(appPts, BRASS, nowLead, true);
  } else {
    line(appPts, MUTED_BRASS, 1.4);
    line(regPts, PINE, 2);
    endDot(appPts, MUTED_BRASS, nowLead, false);
    endDot(regPts, PINE, nowLead, true);
  }

  for (const d of [maxLead, 0]) {
    const lab = svgEl('text', {
      x: d < 0.05 ? W - padR : padL, y: H - padB + 13,
      'font-size': 8.5, fill: '#7c8b8f', 'text-anchor': d < 0.05 ? 'end' : 'start',
      'font-family': 'IBM Plex Mono, monospace',
    });
    lab.textContent = d < 0.05 ? 'event' : `${Math.round(d)}d out`;
    svg.appendChild(lab);
  }
  if (upcoming) {
    const nowLab = svgEl('text', {
      x: Math.min(x(nowLead), W - padR - 2), y: H - padB + 13, 'font-size': 8.5,
      fill: PINE, 'text-anchor': 'middle', 'font-family': 'IBM Plex Mono, monospace',
    });
    nowLab.textContent = 'now';
    svg.appendChild(nowLab);
  }

  const key = svgEl('text', {
    x: padL, y: H - 2, 'font-size': 9, fill: '#52646a',
    'font-family': 'IBM Plex Mono, monospace',
  });
  key.textContent = `${peak} registered  \u00b7  ${appPts[appPts.length - 1][1]} approved`;
  svg.appendChild(key);
  host.appendChild(svg);
}

/** How many families booked one seat, two seats, three, and so on. */
function drawPartyChart(host, listHost, families) {
  const counts = new Map();
  for (const f of families) counts.set(f.tickets, (counts.get(f.tickets) || 0) + 1);
  const entries = [...counts.entries()].sort((a, b) => a[0] - b[0]);
  const total = families.length || 1;
  const W = 200, R = 84, cx = W / 2, cy = 92, pad = 4;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${cy + R + pad}` });
  let angle = -Math.PI / 2;
  entries.forEach(([k, v], i) => {
    const color = PARTY_COLORS[Math.min(i, PARTY_COLORS.length - 1)];
    const sweep = (v / total) * Math.PI * 2;
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const pt = (r, a) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
    const d = entries.length === 1
      ? `M ${cx - R} ${cy} A ${R} ${R} 0 1 1 ${cx + R} ${cy} A ${R} ${R} 0 1 1 ${cx - R} ${cy} Z`
      : `M ${cx} ${cy} L ${pt(R, angle)} A ${R} ${R} 0 ${large} 1 ${pt(R, end)} Z`;
    svg.appendChild(svgEl('path', { d, fill: color, stroke: '#fafbf8', 'stroke-width': 1.5 }));
    angle = end;
  });
  host.innerHTML = '';
  host.appendChild(svg);

  listHost.innerHTML = '';
  entries.forEach(([k, v], i) => {
    const row = document.createElement('div');
    row.className = 'src-row';
    const swatch = document.createElement('i');
    swatch.style.background = PARTY_COLORS[Math.min(i, PARTY_COLORS.length - 1)];
    const name = document.createElement('span');
    name.textContent = k === 1 ? 'Solo' : `Group of ${k}`;
    const num = document.createElement('b');
    num.textContent = `${v}  ${Math.round((v / total) * 100)}%`;
    row.append(swatch, name, num);
    listHost.appendChild(row);
  });
}

function drawGradChart(host, families) {
  const buckets = new Map();
  for (const f of families) {
    const k = f.gradYear ? String(f.gradYear) : 'Not reported';
    buckets.set(k, (buckets.get(k) || 0) + 1);
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === 'Not reported') return 1;
    if (b === 'Not reported') return -1;
    return Number(a) - Number(b);
  });
  const W = 400, H = 180, padL = 8, padB = 34, top = 12;
  const max = Math.max(...buckets.values(), 1);
  const bw = (W - padL * 2) / keys.length;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}` });
  keys.forEach((k, i) => {
    const v = buckets.get(k);
    const h = (v / max) * (H - padB - top);
    const cx = padL + bw * i + bw / 2;
    svg.appendChild(svgEl('rect', {
      x: cx - Math.min(bw * 0.34, 26), y: H - padB - h, width: Math.min(bw * 0.68, 52), height: h,
      fill: k === 'Not reported' ? '#c3cbc4' : PINE, rx: 1,
    }));
    const val = svgEl('text', { x: cx, y: H - padB - h - 5, 'font-size': 11, 'text-anchor': 'middle', fill: INK, 'font-family': 'IBM Plex Mono, monospace' });
    val.textContent = v;
    svg.appendChild(val);
    const lab = svgEl('text', { x: cx, y: H - padB + 15, 'font-size': 11, 'text-anchor': 'middle', fill: '#52646a', 'font-family': 'Familjen Grotesk, sans-serif' });
    lab.textContent = k === 'Not reported' ? 'None' : k;
    svg.appendChild(lab);
  });
  const cap = svgEl('text', { x: W / 2, y: H - 6, 'font-size': 10, 'text-anchor': 'middle', fill: '#7c8b8f', 'font-family': 'IBM Plex Mono, monospace' });
  cap.textContent = 'families by student graduation year';
  svg.appendChild(cap);
  host.innerHTML = '';
  host.appendChild(svg);
}

function drawSourceChart(host, listHost, families) {
  const counts = new Map();
  for (const f of families) {
    const k = f.utm ? f.utm : '__none__';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => {
    if (a[0] === '__none__') return 1;
    if (b[0] === '__none__') return -1;
    return b[1] - a[1];
  });
  const total = families.length || 1;
  const W = 220, R = 84, cx = W / 2, cy = 100, inner = 46;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} 200` });
  let angle = -Math.PI / 2;
  entries.forEach(([k, v], i) => {
    const color = k === '__none__' ? NO_SOURCE : SRC_COLORS[i % SRC_COLORS.length];
    const sweep = (v / total) * Math.PI * 2;
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const pt = (r, a) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
    const d = entries.length === 1
      ? `M ${cx - R} ${cy} A ${R} ${R} 0 1 1 ${cx + R} ${cy} A ${R} ${R} 0 1 1 ${cx - R} ${cy} Z
         M ${cx - inner} ${cy} A ${inner} ${inner} 0 1 0 ${cx + inner} ${cy} A ${inner} ${inner} 0 1 0 ${cx - inner} ${cy} Z`
      : `M ${pt(R, angle)} A ${R} ${R} 0 ${large} 1 ${pt(R, end)} L ${pt(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${pt(inner, angle)} Z`;
    svg.appendChild(svgEl('path', { d, fill: color, 'fill-rule': 'evenodd', stroke: '#fafbf8', 'stroke-width': 1.5 }));
    angle = end;
  });
  const mid = svgEl('text', { x: cx, y: cy + 2, 'font-size': 22, 'text-anchor': 'middle', fill: INK, 'font-weight': 600, 'font-family': 'Familjen Grotesk, sans-serif' });
  mid.textContent = families.length;
  svg.appendChild(mid);
  const sub = svgEl('text', { x: cx, y: cy + 17, 'font-size': 10, 'text-anchor': 'middle', fill: '#7c8b8f', 'font-family': 'IBM Plex Mono, monospace' });
  sub.textContent = 'families';
  svg.appendChild(sub);
  host.innerHTML = '';
  host.appendChild(svg);

  listHost.innerHTML = '';
  entries.forEach(([k, v], i) => {
    const row = document.createElement('div');
    row.className = 'src-row';
    const swatch = document.createElement('i');
    swatch.style.background = k === '__none__' ? NO_SOURCE : SRC_COLORS[i % SRC_COLORS.length];
    const name = document.createElement('span');
    name.textContent = k === '__none__' ? 'No source tag' : k;
    const num = document.createElement('b');
    num.textContent = `${v}  ${Math.round((v / total) * 100)}%`;
    row.append(swatch, name, num);
    listHost.appendChild(row);
  });
}

/* ---------- table ---------- */

const COLUMNS = [
  ['Registrant', 'name'], ['Likely to attend', 'prob'], ['Attended', 'attended'], 
  ['Tickets', 'tickets'], ['Registered', 'registered'], ['Days ahead', 'lead'], 
  ['Miles out', 'miles'], ['Status', 'status'], ['Grad year', 'grad'], 
  ['High school', 'school'], ['ZIP', 'zip'], ['Source', 'source'], ['Email', 'email'],
];

const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function sortFamilies(families, key, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  const cmp = {
    reg: (a, b) => a.registeredMs - b.registeredMs,
    prob: (a, b) => a.prob - b.prob,
    name: (a, b) => a.name.localeCompare(b.name),
    email: (a, b) => a.email.localeCompare(b.email),
    size: (a, b) => a.tickets - b.tickets || a.registeredMs - b.registeredMs,
    miles: (a, b) => (a.miles == null ? Infinity : a.miles) - (b.miles == null ? Infinity : b.miles),
  }[key] || ((a, b) => a.registeredMs - b.registeredMs);
  return [...families].sort((a, b) => mul * cmp(a, b));
}

/** Check-ins as "2/3". Only ever called when the event has already happened. */
function attendanceCell(f) {
  const span = document.createElement('span');
  span.textContent = `${f.checkedIn}/${f.tickets}`;
  span.style.color = f.checkedIn > 0 ? PINE : BRICK;
  span.style.fontWeight = '600';
  return span;
}

/** True once anyone has been scanned in, which is what makes an event past. */
const hasCheckIns = (families) => families.some((f) => f.checkedIn > 0);

function renderTable(families) {
  const showAttended = hasCheckIns(families);
  const columns = COLUMNS.filter(([, key]) => key !== 'attended' || showAttended);
  const head = $('thead');
  head.innerHTML = '';
  for (const [label] of columns) {
    const th = document.createElement('th');
    th.textContent = label;
    head.appendChild(th);
  }
  const body = $('tbody');
  body.innerHTML = '';
  const sorted = sortFamilies(families, $('sort').value, $('dir').value);
  for (const f of sorted) {
    const tr = document.createElement('tr');
    if (!f.inPool) tr.className = 'row-muted';
    const cell = (cls, node) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      if (node instanceof Node) td.appendChild(node); else td.textContent = node;
      tr.appendChild(td);
    };

    cell('c-name', f.name || '\u2013');

    const prob = document.createElement('div');
    prob.className = 'prob';
    const bar = document.createElement('div');
    bar.className = 'prob-bar';
    const fill = document.createElement('div');
    fill.className = 'prob-fill';
    fill.style.width = `${Math.round(f.prob * 100)}%`;
    if (f.forcedZero) fill.style.background = '#9c4a3b';
    bar.appendChild(fill);
    const val = document.createElement('span');
    val.className = 'prob-val';
    val.textContent = f.inPool ? `${Math.round(f.prob * 100)}%` : '\u2013';
    prob.append(bar, val);
    cell('', prob);
    if (showAttended) cell('c-num', attendanceCell(f));
    cell('c-num', f.tickets);
    cell('c-mono', fmtDate(f.registeredMs));
    cell('c-num', f.leadDays.toFixed(1));
    cell('c-num', f.miles == null ? '\u2013' : f.miles.toFixed(1));

    const tag = document.createElement('span');
    tag.className = `tag tag-${f.status}`;
    tag.textContent = f.status === 'pending' ? 'Awaiting' : f.status;
    cell('', tag);

    cell('c-mono', f.gradYear || '\u2013');
    cell('', f.school || '\u2013');
    cell('c-mono', f.zip || '\u2013');
    cell('c-mono', f.utm || '\u2013');
    cell('c-mono', f.email || '\u2013');
    body.appendChild(tr);
  }
}

function exportCsv(families) {
  const sorted = sortFamilies(families, $('sort').value, $('dir').value);
  const showAttended = hasCheckIns(families);
  const columns = COLUMNS.filter(([, key]) => key !== 'attended' || showAttended);
  const header = columns.map(([label]) => label);
  const lines = [header.join(',')];
  for (const f of sorted) {
    const row = [
      f.name, f.inPool ? (f.prob * 100).toFixed(1) + '%' : 'excluded',
      ...(showAttended ? [`${f.checkedIn}/${f.tickets}`] : []), f.tickets,
      new Date(f.registeredMs).toISOString(), f.leadDays.toFixed(2),
      f.miles == null ? '' : f.miles.toFixed(2), f.status,
      f.gradYear || '', f.school, f.zip, f.utm, f.email,
    ];
    lines.push(row.map((v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.fileName || 'event').replace(/\.[^.]+$/, '')}-forecast.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- rendering ---------- */

function statCard(label, value, note) {
  const div = document.createElement('div');
  div.className = 'stat';
  div.innerHTML = '<p class="stat-k"></p><div class="stat-v"></div><p class="stat-n"></p>';
  div.querySelector('.stat-k').textContent = label;
  div.querySelector('.stat-v').textContent = value;
  div.querySelector('.stat-n').textContent = note;
  return div;
}

/** Read the venue box and report back what it resolved to, or didn't. */
function syncVenue() {
  const text = $('venue').value.trim();
  state.venueText = text;
  state.venue = resolveVenue(text);
  const note = $('venueNote');
  if (!text) {
    note.className = 'field-note';
    note.textContent = 'A past venue name, a city, a ZIP, or a latitude and longitude pair. Without it the forecast ignores how far guests have to travel.';
  } else if (state.venue) {
    note.className = 'field-note venue-ok';
    note.textContent = `Found it: ${state.venue[0].toFixed(4)}, ${state.venue[1].toFixed(4)}. Travel distance is in the forecast.`;
  } else {
    note.className = 'field-note venue-miss';
    note.textContent = 'Not recognized, so distance is left out. Try a ZIP code, a nearby city, or paste coordinates from a map.';
  }
}

function render() {
  const model = state.model;
  if (!model || !state.rows.length) return;

  /* The date field is optional. If it is blank, fall back to a date in the
     uploaded filename. Only if both are missing is there nothing to measure
     lead times against. */
  const fromName = (state.fileName.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
  const dateVal = $('date').value || fromName || '';
  if (!dateVal) {
    $('empty').hidden = false;
    $('results').hidden = true;
    $('empty').querySelector('h2').textContent = 'One more thing';
    $('empty').querySelector('p').textContent =
      'Set the event date, or name the file starting with it, so registration lead times can be measured.';
    return;
  }
  if (!$('date').value && fromName) {
    $('dateNote').textContent = `Using ${fromName} from the filename. Set a date above to override it.`;
  }

  const tz = $('tz').value;
  const startMs = eventStartMs(dateVal, tz);
  const families = buildFamilies(state.rows, startMs);
  attachDistance(families, state.venue);

  /* A finished event has had its cancellations worked through by definition,
     so the switch turns itself on. Done once per upload rather than every
     render, which leaves it free to be turned back off by hand. */
  const past = hasCheckIns(families);
  let autoDeclined = false;
  if (past && !state.declinedAutoSet) {
    state.declinedAutoSet = true;
    if (!$('optDeclined').checked) {
      $('optDeclined').checked = true;
      autoDeclined = true;
    }
  }

  const includePending = $('optPending').checked;
  const cancellationsDone = $('optDeclined').checked;
  const fit = cancellationsDone ? model.stillOn : model.everyone;

  for (const f of families) {
    f.inPool = includePending || f.status !== 'pending';
    f.forcedZero = cancellationsDone && f.status === 'cancelled';
    f.prob = f.forcedZero ? 0 : predictOne(fit, f);
  }
  const pool = families.filter((f) => f.inPool);
  state.families = families;

  if (!pool.length) {
    $('alert').innerHTML = '<div class="alert">No guests to forecast. Turn on \u201cCount guests awaiting approval\u201d if the list is all pending.</div>';
    $('results').hidden = true;
    $('empty').hidden = true;
    return;
  }

  const notes = [];
  if (autoDeclined) {
    notes.push('This event has already happened, so \u201cnot going\u201d replies are being taken at their word. Turn that switch off to forecast those families like everyone else.');
  }
  for (const s of model.skipped || []) notes.push(`Skipped in the training folder: ${s}.`);
  if (state.venueText && !state.venue) {
    notes.push('The venue could not be located, so travel distance is not part of this forecast.');
  }
  if (state.venue && model.useDist) {
    const known = pool.filter((f) => f.miles != null).length;
    if (known < pool.length * 0.5) {
      notes.push(`Only ${known} of ${pool.length} families have a ZIP the model recognizes, so distance is doing little work on this list.`);
    }
  }
  $('alert').innerHTML = notes.map((n) => `<div class="alert">${n}</div>`).join('');

  const level = Number($('ci').value);
  const sim = simulate(fit, model.companionRate, pool, { draws: 6000 });

  /* Only a finished event has check-ins, and only then is there a real
     outcome to draw against the forecast. */
  const actualPeople = past ? pool.reduce((s, f) => s + f.checkedIn, 0) : undefined;
  const actualFams = past ? pool.filter((f) => f.checkedIn > 0).length : undefined;

  const people = drawDistribution($('peoplePlot'), sim, level, 'people', actualPeople);
  const fams = drawDistribution($('familyPlot'), sim, level, 'fams', actualFams);

  const pct = level >= 0.99 ? (level * 100).toFixed(1).replace(/\.0$/, '') : Math.round(level * 100);
  $('peopleRange').innerHTML = `${people.outer.lo}<span class="to">to</span>${people.outer.hi}`;
  $('familyRange').innerHTML = `${fams.outer.lo}<span class="to">to</span>${fams.outer.hi}`;
  $('peopleSub').innerHTML = `Most likely <b>${Math.round(sim.expected.people)}</b> of ${pool.reduce((s, f) => s + f.tickets, 0)} tickets booked`;
  $('familySub').innerHTML = `Most likely <b>${Math.round(sim.expected.families)}</b> of ${pool.length} families registered`;
  $('forecastHint').textContent = `${pct}% range \u00b7 ${pool.length} families in the forecast`;

  const booked = pool.reduce((s, f) => s + f.tickets, 0);
  const approved = families.filter((f) => f.status === 'approved');
  const groups = pool.filter((f) => f.isGroup).length;
  const pending = families.filter((f) => f.status === 'pending').length;
  const farOut = pool.filter((f) => f.miles != null && f.miles > model.distCap).length;

  const stats = $('stats');
  stats.innerHTML = '';
  stats.append(
    statCard('Headcount to plan for', people.outer.hi, `upper end of the ${pct}% range`),
    statCard('If everyone showed', approved.reduce((s, f) => s + f.tickets, 0), `${approved.length} approved families`),
    statCard('Empty seats expected', Math.max(booked - Math.round(sim.expected.people), 0), `of ${booked} tickets booked`),
    statCard('Booked as a group', `${groups}/${pool.length}`, 'groups show up far more often'),
    statCard('Awaiting approval', pending, includePending ? 'counted in the forecast' : 'not counted'),
    statCard('Cancelled', families.filter((f) => f.status === 'cancelled').length,
      cancellationsDone ? 'counted as not attending' : 'forecast like everyone else'),
  );
  /* Kept in the same row rather than dropped onto a slab of its own. */
  if (model.useDist && state.venue) {
    stats.append(statCard('Beyond the usual radius', farOut,
      `scored at the ${model.distCap.toFixed(0)} mile edge, not further`));
  }

  drawGrowthChart($('growthChart'), families, includePending, startMs);
  drawPartyChart($('partyChart'), $('partyList'), pool);

  drawGradChart($('gradChart'), pool);
  $('gradHint').textContent = `${pool.filter((f) => !f.gradYear).length} not reported`;
  drawSourceChart($('srcChart'), $('srcList'), pool);
  renderTable(families);

  const coefs = $('coefs');
  coefs.innerHTML = '';
  const addCoef = (k, v, color) => {
    const row = document.createElement('div');
    row.className = 'coef-row';
    const kk = document.createElement('span');
    kk.textContent = k;
    const vv = document.createElement('b');
    vv.textContent = v;
    if (color) vv.style.color = color;
    row.append(kk, vv);
    coefs.appendChild(row);
  };
  const gi = fit.terms.indexOf('group');
  const di = fit.terms.indexOf('distance');
  addCoef('Solo booking', `${Math.round(fit.soloRate * 100)}% attend`);
  addCoef('Booked 2 or more', `${Math.round(fit.groupRate * 100)}% attend`);
  if (gi >= 0) addCoef('A group vs a solo', `${Math.exp(fit.beta[gi]).toFixed(2)}x the odds`, PINE);

  /* The lead curve is a handful of control points, which mean nothing on their
     own, so show what the curve does rather than what it is made of. */
  const probe = (over) => predictOne(fit, Object.assign(
    { leadDays: 7, isGroup: 0, tickets: 1, miles: null }, over));
  addCoef('Signed up this week', `${Math.round(probe({ leadDays: 3 }) * 100)}% attend`);
  addCoef('Signed up a month out', `${Math.round(probe({ leadDays: 30 }) * 100)}% attend`);
  if (di >= 0) {
    addCoef('Lives 5 miles out', `${Math.round(probe({ miles: 5 }) * 100)}% attend`);
    addCoef(`Lives ${model.distCap.toFixed(0)}+ miles out`, `${Math.round(probe({ miles: model.distCap }) * 100)}% attend`, '#9c4a3b');
    addCoef('No ZIP on file', `${Math.round(probe({}) * 100)}% attend`);
  }
  addCoef('Extra seats filled', `${Math.round(model.companionRate * 100)}%`);
  if (cancellationsDone) addCoef('Cancelled families', 'counted out', '#9c4a3b');

  const ts = $('trainStats');
  ts.innerHTML = '';
  const addRow = (k, v) => {
    const row = document.createElement('div');
    row.className = 'coef-row';
    const a = document.createElement('span');
    a.textContent = k;
    const b = document.createElement('b');
    b.textContent = v;
    row.append(a, b);
    ts.appendChild(row);
  };
  addRow('Families learned from', model.n);
  for (const ev of model.loaded || []) {
    const dist = ev.hasVenue ? `${ev.withMiles} located` : 'no venue set';
    addRow(`\u00b7 ${ev.label}`, `${ev.n} families${ev.date ? ` \u00b7 ${ev.date}` : ''} \u00b7 ${dist}`);
  }
  addRow('Cancelled by the team', model.cancelledN);
  addRow('Travel distance in use', model.useDist
    ? `yes \u00b7 ${Math.round(model.distCoverage * 100)}% of families located`
    : 'no \u00b7 too few located families to fit it');
  if (model.useDist) {
    addRow('Distance settings', `capped at ${model.distCap.toFixed(1)} mi \u00b7 k = ${model.distK}`);
  }
  addRow('Fit in use', cancellationsDone ? 'after cancellations' : 'before cancellations');
  addRow('Solo turnout', `${Math.round(fit.soloRate * 100)}% of ${fit.soloN}`);
  addRow('Group turnout', `${Math.round(fit.groupRate * 100)}% of ${fit.groupN}`);

  const distPara = model.useDist ? `
    <p><strong>Travel distance.</strong> Straight-line miles from a family&rsquo;s ZIP to the venue.
    Distances are capped at ${model.distCap.toFixed(0)} miles, the far edge of what past guest lists
    actually covered, so a family further out is scored as if they lived at that edge rather than
    having a probability invented for them from no evidence. The effect is centered, which means a
    family with no ZIP on file is scored at the average travel effect and is neither rewarded nor
    penalized for the blank. Both the cap and the curve&rsquo;s steepness are worked out from the
    training files, so they move as events are added. Right now
    ${Math.round(model.distCoverage * 100)}% of past families could be located, so read this
    predictor as a signal about the catchment area rather than a law about driving time.</p>` : `
    <p><strong>Travel distance.</strong> Not in use. Either too few past families have a ZIP the
    model recognizes, or too few past events have venue coordinates in the manifest. Add
    <code>lat</code> and <code>lon</code> to the manifest entries to turn it on.</p>`;

  $('method').innerHTML = `
    <p><strong>The model.</strong> A logistic regression on past guest lists with three predictors:
    whether the family booked more than one ticket, how far ahead they registered, and how far they
    live from the venue. Lead time is a curve that is only allowed to fall, never rise, because a
    straight-line version looked convincing on three events and collapsed on five. Graduation year,
    GPA, coast, registration order, income and education were all tested and none earned a place.
    There is no machine learning here, so every number above can be checked by hand.</p>
    ${distPara}
    <p><strong>Cancellations.</strong> A guest marked not going is almost always the events team
    recording what they already know, rather than the guest changing their own mind. Across these
    events only two guests ever did it themselves. So two versions are fitted. Before the team has
    worked through the list, nobody&rsquo;s status tells you anything, and every family is scored
    the same way at rates that already allow for the cancellations still to come. Afterwards,
    cancelled families are counted out and the ones left over attend at a higher rate. The switch
    above picks between them.</p>
    <p><strong>The range.</strong> Two things are uncertain at once. Even a perfect model cannot
    know who walks in on the night, and this one was fitted on ${model.n} families from
    ${model.events.length} events, so its own coefficients are approximate. The second part is
    measured by refitting the whole model on events resampled with replacement, ${model.bootstrapN}
    times, rather than by assuming the coefficients follow a bell curve. Whole events are resampled
    rather than families, because families at one dinner share an invitation, a venue and an
    evening, so treating them as independent would make the model look far surer than it is. The
    forecast then runs 6,000 simulated evenings, each one picking a refit at random and flipping a
    coin per family, and reports the middle ${pct}%.</p>
    <p><strong>Excluded.</strong> Internal test registrations never enter any part of this page.</p>`;

  $('empty').hidden = true;
  $('results').hidden = false;
}

/* ---------- wiring ---------- */

async function handleFiles(files) {
  const file = files && files[0];
  if (!file) return;
  try {
    const rows = await readFile(file);
    if (!rows.length || !('created_at' in rows[0])) {
      throw new Error(`${file.name} doesn't look like a Luma guest export (no created_at column).`);
    }
    state.rows = rows;
    state.fileName = file.name;
    state.declinedAutoSet = false;   // a fresh list gets a fresh look at the switch
    $('dropFile').textContent = `${file.name} \u00b7 ${rows.filter((r) => !isTestSignup(r)).length} guest rows`;

    const det = detectTz(rows);
    state.detected = det;
    $('tz').value = det.tz;
    const zipCount = Object.values(det.counts).reduce((a, b) => a + b, 0);
    $('tzNote').textContent = det.inferred
      ? `Doors at 6:00 PM ${TZ_LABEL[det.tz]}, read from ${zipCount} ZIP code${zipCount === 1 ? '' : 's'}.`
      : 'No ZIP codes in this file, so Pacific is assumed. Change it if that is wrong.';

    if (rows.some((r) => String(r.checked_in_at || '').trim())) {
      $('alert').innerHTML = '<div class="alert">This export already has check-ins, so it looks like a past event. The forecast still runs, but it is predicting something that already happened.</div>';
    }
    render();
  } catch (err) {
    $('alert').innerHTML = `<div class="alert">${err.message}</div>`;
  }
}

function init() {
  const drop = $('drop');
  $('file').addEventListener('change', (e) => handleFiles(e.target.files));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('is-over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove('is-over');
  }));
  drop.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));

  ['date', 'tz', 'ci', 'optPending', 'optDeclined'].forEach((id) => $(id).addEventListener('change', render));
  $('venue').addEventListener('input', () => { syncVenue(); render(); });
  ['sort', 'dir'].forEach((id) => $(id).addEventListener('change', () => renderTable(state.families)));
  $('export').addEventListener('click', () => exportCsv(state.families));
  syncVenue();

  loadTraining().then((model) => {
    state.model = model;
    $('trainChip').innerHTML =
      `Fitted on <b>${model.n} families</b> from ${model.events.length} past events<br>`
      + `solo ${Math.round(model.everyone.soloRate * 100)}% \u00b7 group ${Math.round(model.everyone.groupRate * 100)}% turnout`;
    render();
    refineModel();
  }).catch((err) => {
    state.trainError = err;
    $('trainChip').innerHTML = '<b>No past events loaded</b>';
    $('alert').innerHTML =
      `<div class="alert">${err.message} The page needs to be served over http (GitHub Pages, or <code>python3 -m http.server</code> locally) so it can read the training folder.</div>`;
  });
}

document.addEventListener('DOMContentLoaded', init);
