/* Event yield model: logistic regression + Monte Carlo forecast.
   No machine learning, no black boxes. Every number here can be traced by hand. */

/* ---------- people who must never appear anywhere ---------- */

const TEST_SIGNUPS = [
  'aryan narendra', 'theresa shropshire', 'anish gupta', 'anvi gupta',
  'ethan klets', 'alison hamilton', 'bethany liu', 'saawan duvvuri',
  'changxiao xie', 'jerry wei',
];

const norm = (s) => String(s == null ? '' : s)
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ').trim().toLowerCase();

/** True for internal test registrations. Applied before anything else touches a row. */
function isTestSignup(row) {
  const email = norm(row.email);
  if (email.includes('empowerly')) return true;
  const full = norm(row.name) || norm(`${row.first_name || ''} ${row.last_name || ''}`);
  const joined = norm(`${row.first_name || ''} ${row.last_name || ''}`);
  return TEST_SIGNUPS.includes(full) || TEST_SIGNUPS.includes(joined);
}

/* ---------- time zones ---------- */

const ZIP_TZ = [
  [10, 89, 'ET'], [100, 199, 'ET'], [200, 349, 'ET'], [350, 369, 'CT'],
  [370, 385, 'CT'], [386, 397, 'CT'], [398, 399, 'ET'], [400, 427, 'ET'],
  [430, 499, 'ET'], [500, 567, 'CT'], [570, 588, 'CT'], [590, 599, 'MT'],
  [600, 693, 'CT'], [700, 799, 'CT'], [800, 847, 'MT'], [850, 865, 'MST'],
  [870, 884, 'MT'], [889, 898, 'PT'], [900, 961, 'PT'], [967, 968, 'HST'],
  [970, 994, 'PT'], [995, 999, 'AKT'],
];
const TZ_OFFSET = { ET: -5, CT: -6, MT: -7, MST: -7, PT: -8, AKT: -9, HST: -10 };
const TZ_LABEL = {
  ET: 'Eastern', CT: 'Central', MT: 'Mountain', MST: 'Arizona',
  PT: 'Pacific', AKT: 'Alaska', HST: 'Hawaii',
};
const NO_DST = new Set(['MST', 'HST']);

function zipToTz(zip) {
  const m = String(zip == null ? '' : zip).match(/(\d{3})/);
  if (!m) return null;
  const p = parseInt(m[1], 10);
  for (const [lo, hi, tz] of ZIP_TZ) if (p >= lo && p <= hi) return tz;
  return null;
}

/** Majority time zone across registrant ZIPs; Pacific when the sheet has none. */
function detectTz(rows) {
  const counts = {};
  for (const r of rows) {
    const tz = zipToTz(r['Zip code']);
    if (tz) counts[tz] = (counts[tz] || 0) + 1;
  }
  const found = Object.keys(counts);
  if (!found.length) return { tz: 'PT', inferred: false, counts };
  found.sort((a, b) => counts[b] - counts[a]);
  return { tz: found[0], inferred: true, counts };
}

function dstActive(tz, y, m, d) {
  if (NO_DST.has(tz)) return false;
  const march = new Date(Date.UTC(y, 2, 8));
  const secondSunday = 8 + ((7 - march.getUTCDay()) % 7);
  const nov = new Date(Date.UTC(y, 10, 1));
  const firstSunday = 1 + ((7 - nov.getUTCDay()) % 7);
  const day = new Date(Date.UTC(y, m - 1, d));
  return day >= new Date(Date.UTC(y, 2, secondSunday)) && day < new Date(Date.UTC(y, 10, firstSunday));
}

/** Doors at 6:00 PM local on the given date, returned as a UTC timestamp. */
function eventStartMs(dateStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const offset = TZ_OFFSET[tz] + (dstActive(tz, y, m, d) ? 1 : 0);
  return Date.UTC(y, m - 1, d, 18 - offset, 0, 0);
}

const EAST_TZ = new Set(['ET']);
const regionForTz = (tz) => (EAST_TZ.has(tz) ? 'East' : 'West');

/* ---------- families ---------- */

/** Group Luma ticket rows into families (same email = same family). */
function buildFamilies(rows, startMs) {
  const map = new Map();
  for (const row of rows) {
    if (isTestSignup(row)) continue;
    const key = norm(row.email) || norm(row.name);
    if (!key) continue;
    const created = Date.parse(row.created_at);
    if (!Number.isFinite(created)) continue;
    let fam = map.get(key);
    if (!fam) {
      fam = {
        key,
        name: String(row.name || `${row.first_name || ''} ${row.last_name || ''}`).trim(),
        email: String(row.email || '').trim(),
        phone: String(row.phone_number || '').trim(),
        tickets: 0,
        registeredMs: created,
        statuses: [],
        checkedIn: 0,
        gradYear: null,
        school: '',
        zip: '',
        utm: '',
        registrantType: '',
        priorCounselor: '',
        gpa: '',
      };
      map.set(key, fam);
    }
    fam.tickets += 1;
    fam.registeredMs = Math.min(fam.registeredMs, created);
    fam.statuses.push(String(row.approval_status || '').trim().toLowerCase());
    if (String(row.checked_in_at || '').trim()) fam.checkedIn += 1;
    const gy = parseInt(row["Student's high school graduation year"], 10);
    if (!fam.gradYear && Number.isFinite(gy)) fam.gradYear = gy;
    if (!fam.school && row["Student's high school"]) fam.school = String(row["Student's high school"]).trim();
    if (!fam.zip && row['Zip code']) fam.zip = String(row['Zip code']).trim();
    if (!fam.utm && row.utm_source) fam.utm = String(row.utm_source).trim();
    if (!fam.registrantType && row['Who is registering for this event?']) {
      fam.registrantType = String(row['Who is registering for this event?']).trim();
    }
    if (!fam.priorCounselor && row['Have you worked with a private college counselor before?']) {
      fam.priorCounselor = String(row['Have you worked with a private college counselor before?']).trim();
    }
    if (!fam.gpa && row['Unweighted grade point average (GPA)']) {
      fam.gpa = String(row['Unweighted grade point average (GPA)']).trim();
    }
  }
  const families = [...map.values()];
  for (const f of families) {
    f.leadDays = (startMs - f.registeredMs) / 86400000;
    f.isGroup = f.tickets > 1 ? 1 : 0;
    /* "cancelled" rather than "declined": in practice these are almost always
       set by the events team once they know a family is out, not by the guest.
       Across four events only two guests ever changed their own status. */
    f.status = f.statuses.every((s) => s === 'declined') ? 'cancelled'
      : f.statuses.some((s) => s === 'approved') ? 'approved'
        : 'pending';
  }
  return families;
}

/* ---------- small dense linear algebra ---------- */

function matInv(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row) => row.slice(n));
}

function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) L[i][j] = Math.sqrt(Math.max(s, 1e-12));
      else L[i][j] = s / L[j][j];
    }
  }
  return L;
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

/* ---------- logistic regression (IRLS with a light ridge) ---------- */

/**
 * Fit P(attend) = sigmoid(Xb). A light ridge penalty (not applied to the
 * intercept) keeps the fit finite if a future event ever has a cell where every
 * family attends or none do. It is small enough that the fitted rates stay
 * within a point of the raw ones.
 */
function fitLogistic(X, y, lambda = 0.1, iters = 40) {
  const n = X.length;
  const p = X[0].length;
  let beta = new Array(p).fill(0);
  let XtWX = null;
  for (let it = 0; it < iters; it++) {
    const A = Array.from({ length: p }, () => new Array(p).fill(0));
    const b = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const eta = dot(X[i], beta);
      const mu = sigmoid(eta);
      const w = Math.max(mu * (1 - mu), 1e-6);
      const z = eta + (y[i] - mu) / w;
      for (let r = 0; r < p; r++) {
        b[r] += w * X[i][r] * z;
        for (let c = 0; c < p; c++) A[r][c] += w * X[i][r] * X[i][c];
      }
    }
    XtWX = A.map((row) => [...row]);
    for (let r = 1; r < p; r++) A[r][r] += lambda;
    const inv = matInv(A);
    if (!inv) break;
    const next = inv.map((row) => dot(row, b));
    const delta = Math.max(...next.map((v, i) => Math.abs(v - beta[i])));
    beta = next;
    if (delta < 1e-9) break;
  }
  const pen = XtWX.map((row) => [...row]);
  for (let r = 1; r < p; r++) pen[r][r] += lambda;
  const cov = matInv(pen) || Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => (i === j ? 1 : 0)));
  return { beta, cov, se: cov.map((row, i) => Math.sqrt(Math.max(row[i], 0))) };
}

/* ---------- building the model ---------- */

/**
 * One predictor: whether the family booked more than one ticket.
 *
 * Registration lead time and coast were both dropped after four events. Lead
 * time looked strong on the first three (OR 0.90 per day, p = 0.004) and then
 * collapsed once the July 30 event was added (p = 0.30), because that event's
 * whole list registered about 37 days out and still turned out normally. Coast
 * never helped. Graduation year, GPA, distance to the venue and registration
 * order were all tested and none of them earned a place.
 *
 * Two versions are fitted, because a family marked "not going" means something
 * different depending on when you look:
 *
 *   everyone  before cancellations have been processed, nobody's status tells
 *             you anything yet, so every family is scored the same way and the
 *             rates already absorb the cancellations still to come.
 *   stillOn   after cancellations, those families are known to be out, and the
 *             ones left over attend at a higher rate.
 */
function buildModel(trainRows) {
  const fitPool = (rows) => {
    const useGroup = new Set(rows.map((r) => r.isGroup)).size > 1;
    const design = (row) => (useGroup ? [1, row.isGroup] : [1]);
    const fit = fitLogistic(rows.map(design), rows.map((r) => r.attended));
    const rate = (pred) => {
      const sub = rows.filter(pred);
      return sub.length ? sub.filter((r) => r.attended === 1).length / sub.length : null;
    };
    return {
      ...fit,
      design,
      terms: useGroup ? ['intercept', 'group'] : ['intercept'],
      n: rows.length,
      soloRate: rate((r) => r.isGroup === 0),
      groupRate: rate((r) => r.isGroup === 1),
      soloN: rows.filter((r) => r.isGroup === 0).length,
      groupN: rows.filter((r) => r.isGroup === 1).length,
      baseRate: rows.length ? rows.filter((r) => r.attended === 1).length / rows.length : null,
    };
  };

  const cancelled = trainRows.filter((r) => r.status === 'cancelled');
  const remaining = trainRows.filter((r) => r.status !== 'cancelled');

  const everyone = fitPool(trainRows);
  const stillOn = fitPool(remaining.length >= 12 ? remaining : trainRows);

  // Of the extra seats a family booked, how many actually walk in when they come.
  const attending = trainRows.filter((r) => r.attended === 1);
  const extraBooked = attending.reduce((s, r) => s + (r.tickets - 1), 0);
  const extraChecked = attending.reduce((s, r) => s + Math.max(r.ticketsChecked - 1, 0), 0);
  const companionRate = extraBooked > 0 ? Math.min(extraChecked / extraBooked, 1) : 0.9;

  return {
    everyone,
    stillOn,
    companionRate,
    n: trainRows.length,
    cancelledN: cancelled.length,
    events: [...new Set(trainRows.map((r) => r.eventId))],
  };
}

/** Probability for one family under a given fit. */
const predictOne = (fit, fam) => sigmoid(dot(fit.design(fam), fit.beta));

/* ---------- Monte Carlo forecast ---------- */

function randn(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Two sources of uncertainty, simulated together:
 *   1. the fit comes from a handful of past events, so the coefficients
 *      themselves are uncertain and are redrawn on every simulated evening;
 *   2. even with perfect coefficients, each family is a coin flip on the night.
 * Holding the coefficients fixed isolates the second, which is reported next to
 * the combined range.
 */
function simulate(fit, companionRate, families, { draws = 6000, seed = 7 } = {}) {
  const rng = mulberry32(seed);
  const L = cholesky(fit.cov);
  const p = fit.beta.length;
  const rows = families.map((f) => ({ x: fit.design(f), tickets: f.tickets, forced: f.forcedZero }));

  const run = (varyBeta) => {
    const fams = new Array(draws);
    const people = new Array(draws);
    for (let d = 0; d < draws; d++) {
      let beta = fit.beta;
      if (varyBeta) {
        const z = Array.from({ length: p }, () => randn(rng));
        beta = fit.beta.map((b, i) => b + dot(L[i].slice(0, i + 1), z.slice(0, i + 1)));
      }
      let nf = 0, np = 0;
      for (const r of rows) {
        const prob = r.forced ? 0 : sigmoid(dot(r.x, beta));
        if (rng() < prob) {
          nf += 1;
          np += 1;
          for (let t = 1; t < r.tickets; t++) if (rng() < companionRate) np += 1;
        }
      }
      fams[d] = nf;
      people[d] = np;
    }
    return { fams, people };
  };

  const full = run(true);
  const outcomeOnly = run(false);
  const expected = families.reduce(
    (acc, f) => {
      const prob = f.forcedZero ? 0 : predictOne(fit, f);
      acc.families += prob;
      acc.people += prob * (1 + (f.tickets - 1) * companionRate);
      return acc;
    },
    { families: 0, people: 0 },
  );
  return { full, outcomeOnly, expected };
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function interval(samples, level) {
  const sorted = [...samples].sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return {
    lo: Math.floor(percentile(sorted, tail)),
    hi: Math.ceil(percentile(sorted, 1 - tail)),
    median: percentile(sorted, 0.5),
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    TEST_SIGNUPS, norm, isTestSignup, zipToTz, detectTz, eventStartMs, regionForTz,
    buildFamilies, fitLogistic, buildModel, predictOne, simulate, interval, sigmoid,
    TZ_LABEL, TZ_OFFSET,
  };
}
