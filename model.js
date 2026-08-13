/* Event yield model: logistic regression + Monte Carlo forecast.
   No machine learning, no black boxes. Every number here can be traced by hand.

   Three predictors:
     group     whether the family booked more than one ticket
     lead      how far ahead they registered, as a monotone distilled curve
     distance  how far their ZIP is from the venue, on a saturating scale

   Distance is centred on the training mean, so a family with no usable ZIP
   scores exactly at the average distance contribution and is neither rewarded
   nor penalised for the missing field. Everything is fitted in one pass. */

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

/* ---------- geography ---------- */

/* ZIP centroids for every ZIP seen in the guest lists so far. An unknown ZIP
   simply yields no distance, and that family is scored at the average distance
   contribution. Extend this table as new markets appear. */
const ZIP_CENTROIDS = {
  '08055': [39.8637, -74.8223], '08057': [39.9683, -74.9533],
  '08226': [39.2709, -74.5875], '08540': [40.3666, -74.6408],
  '19118': [40.0723, -75.2034], '19120': [40.0343, -75.1213],
  '94022': [37.3814, -122.1258], '94024': [37.3547, -122.0862],
  '94025': [37.4396, -122.1864], '94070': [37.4969, -122.2674],
  '94087': [37.3502, -122.0349], '94301': [37.4443, -122.1497],
  '94303': [37.4673, -122.1388], '94306': [37.4180, -122.1274],
  '94403': [37.5395, -122.2998], '94404': [37.5538, -122.2700],
  '94526': [37.8140, -121.9660], '94536': [37.5605, -121.9999],
  '94538': [37.5308, -121.9712], '94539': [37.5176, -121.9287],
  '94555': [37.5735, -122.0469], '94558': [38.3047, -122.2864],
  '94568': [37.7161, -121.9226], '94582': [37.7621, -121.9140],
  '94588': [37.6873, -121.8957], '95014': [37.3180, -122.0449],
  '95030': [37.2296, -121.9834], '95032': [37.2417, -121.9554],
  '95033': [37.1539, -121.9816], '95035': [37.4352, -121.8950],
  '95051': [37.3483, -121.9844], '95054': [37.3924, -121.9623],
  '95118': [37.2568, -121.8896], '95120': [37.2144, -121.8574],
  '95124': [37.2563, -121.9229], '95126': [37.3249, -121.9153],
  '95129': [37.3066, -122.0002], '95130': [37.2886, -121.9818],
  '95391': [37.7658, -121.5391],
};

/* Free-text venue lookup, so the page can accept "Maggiano's, Santana Row" or
   "downtown Pleasanton" rather than demanding coordinates. Matched on any
   substring. Add rows here as new venues come up. */
const VENUE_ALIASES = [
  ['santana row', [37.3203, -121.9478]], ['maggiano', [37.3210, -121.9475]],
  ['suspiro', [37.3203, -121.9478]], ['cetrella', [37.3785, -122.1141]],
  ['los altos', [37.3785, -122.1141]], ['fitler', [39.9522, -75.1789]],
  ['philadelphia', [39.9522, -75.1789]], ['macarthur park', [37.4437, -122.1653]],
  ['palo alto', [37.4443, -122.1497]], ['pleasanton', [37.6624, -121.8747]],
  ['san jose', [37.3358, -121.8906]], ['fremont', [37.5485, -121.9886]],
  ['dublin', [37.7022, -121.9358]], ['san ramon', [37.7799, -121.9780]],
  ['cupertino', [37.3230, -122.0322]], ['sunnyvale', [37.3688, -122.0363]],
  ['santa clara', [37.3541, -121.9552]], ['milpitas', [37.4323, -121.8996]],
  ['danville', [37.8216, -121.9999]], ['princeton', [40.3573, -74.6672]],
  ['los angeles', [34.0522, -118.2437]], ['pasadena', [34.1478, -118.1445]],
];

/**
 * Turn whatever the user typed into [lat, lon], or null.
 * Accepts explicit coordinates, a ZIP code anywhere in the string, or a known
 * venue or city name. Deliberately offline: no geocoding request, so nothing
 * about an upcoming event leaves the browser.
 */
function resolveVenue(text) {
  if (Array.isArray(text) && text.length === 2 && Number.isFinite(text[0])) return text;
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const pair = s.match(/(-?\d{1,3}\.\d{3,})\s*[,/ ]\s*(-?\d{1,3}\.\d{3,})/);
  if (pair) {
    const lat = parseFloat(pair[1]);
    const lon = parseFloat(pair[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return [lat, lon];
  }
  const zip = s.match(/\b(\d{5})\b/);
  if (zip && ZIP_CENTROIDS[zip[1]]) return ZIP_CENTROIDS[zip[1]];
  const low = norm(s);
  for (const [key, coord] of VENUE_ALIASES) if (low.includes(key)) return coord;
  return null;
}

const EARTH_MILES = 3958.8;
const DEG = Math.PI / 180;

/** Great-circle miles. Bird's eye, not road: road ran about 1.32x this on the
    OSRM pull, and the two correlate too tightly to be separable. */
function haversineMiles(a, b) {
  const p1 = a[0] * DEG;
  const p2 = b[0] * DEG;
  const dp = p2 - p1;
  const dl = (b[1] - a[1]) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* Distance enters as m / (m + k), where m is miles clamped to the far edge of
   what past events actually covered, and k is fitted rather than assumed.

   Both halves matter, for different reasons.

   The clamp is what stops absurd predictions. Distance is heavily bunched: the
   great majority of families sit in the first few miles, so the upper tail is
   almost empty and any smooth curve fitted through it is guessing. Clamping at
   DIST_CLAMP_PCTL means a family past that point is scored as if they were at
   the edge of the evidence rather than extrapolated beyond it, which is the
   same treatment lead time already gets. One July 30 guest entered an Illinois
   ZIP 1,800 miles away and attended; without a clamp that family is scored at
   effectively zero, and with one they land at the far-edge rate.

   k is fitted because it should track the data as events accumulate. Note that
   it is only weakly identified: once miles are clamped, everything from about
   k = 12 upward scores within noise of everything else, because k and its
   coefficient trade off almost exactly. What the data does pin down is the
   size of the effect, not its shape. So selection takes the smallest k within
   DIST_K_TOL of the best score rather than the outright winner, which keeps
   the curve on the conservative side of an argument the evidence cannot settle.

   A monotone distilled Bezier was tried here too, matching the lead-time
   treatment, and was the most robust and worst performing thing tested. The
   shape is already smooth and monotone, so extra control points only
   rediscover what one slope captures. */

const DIST_K_GRID = [3, 5, 8, 12, 18, 26, 40, 60];
/* Used when the caller skips the search, so the page can paint before the
   leave-one-event-out work runs. Sits mid-grid, in the flat region. */
const DEFAULT_DIST_K = 12;
const DIST_K_TOL = 0.005;        // log loss slack for preferring a smaller k
const DIST_CLAMP_PCTL = 0.85;    // clamp miles at this quantile of the training set
const DIST_MIN_FAMILIES = 40;    // below this, distance is not fitted at all
const DIST_MIN_EVENTS = 3;

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

/** Clamped, saturating distance. Bounded above by construction. */
const distanceScale = (miles, k, cap) => {
  const m = Math.min(Math.max(miles, 0), cap);
  return m / (m + k);
};

/** Miles from a family's ZIP to the venue, or null when it cannot be worked out. */
function familyMiles(fam, venue) {
  if (!venue) return null;
  const m = String(fam.zip == null ? '' : fam.zip).match(/(\d{5})/);
  if (!m) return null;
  const home = ZIP_CENTROIDS[m[1]];
  if (!home) return null;
  const miles = haversineMiles(home, venue);
  /* No upper cutoff here on purpose. A wild ZIP is handled by the clamp in the
     model, which scores it at the far edge of the evidence instead of throwing
     the family away. Dropping rows silently is how a typo turns into a deleted
     observation nobody remembers deleting. */
  return Number.isFinite(miles) ? miles : null;
}

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
       Across six events only two guests ever changed their own status. */
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
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/* ---------- Bernstein basis ---------- */

const BINOM = [];
function binom(n, k) {
  if (!BINOM[n]) {
    const row = new Float64Array(n + 1);
    row[0] = 1;
    for (let i = 1; i <= n; i++) row[i] = (row[i - 1] * (n - i + 1)) / i;
    BINOM[n] = row;
  }
  return BINOM[n][k];
}

/** Bernstein basis values for nCtrl control points, written into `out`. */
function bernsteinInto(nCtrl, t, out, offset) {
  const deg = nCtrl - 1;
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  const u = 1 - x;
  // ascending powers of x and descending powers of u, computed once each
  let xp = 1;
  const up = new Float64Array(deg + 1);
  up[0] = 1;
  for (let i = 1; i <= deg; i++) up[i] = up[i - 1] * u;
  for (let i = 0; i <= deg; i++) {
    out[offset + i] = binom(deg, i) * xp * up[deg - i];
    xp *= x;
  }
}

const scaleLead = (v, lo, hi) => (hi <= lo ? 0 : (v - lo) / (hi - lo));

/* ---------- monotone logistic fit ----------

   Control points are written c[0] = a, c[k] = a - sum_{j<k} s[j] with s >= 0,
   so the curve is non-increasing by construction. Bernstein bases sum to one,
   so B.c = a - (B L).s and the logit stays linear in the parameters. The only
   constraint is a box, so the problem is convex and a single solve from any
   feasible start is the global optimum. No restarts, no local minima.

   Solved by projected Newton with an active set. The parameter count is small
   (nHi + 2), so forming and inverting the Hessian each iteration is cheaper
   than the hundreds of first-order steps a gradient method would need. This is
   what keeps a full refit inside a page load on an old machine. */

function solveMonotone(X, y, n, p, nCtrl, lambda, warm) {
  const w = warm ? Float64Array.from(warm) : new Float64Array(p);
  const k = (2 * lambda) / nCtrl;
  const grad = new Float64Array(p);
  const H = Array.from({ length: p }, () => new Float64Array(p));
  const c = new Float64Array(nCtrl);
  const pr = new Float64Array(n);

  const controls = (v) => {
    c[0] = v[0];
    let run = 0;
    for (let j = 1; j < nCtrl; j++) { run += v[j]; c[j] = v[0] - run; }
    return c;
  };

  const nll = (v) => {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const off = i * p;
      let z = 0;
      for (let j = 0; j < p; j++) z += X[off + j] * v[j];
      s += (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z))) - y[i] * z;
    }
    s /= n;
    controls(v);
    let q = 0;
    for (let j = 0; j < nCtrl; j++) q += c[j] * c[j];
    return s + 0.5 * k * q;
  };

  const zCur = new Float64Array(n);
  const zStep = new Float64Array(n);
  let fCur = nll(w);
  for (let it = 0; it < 25; it++) {
    grad.fill(0);
    for (let r = 0; r < p; r++) H[r].fill(0);

    for (let i = 0; i < n; i++) {
      const off = i * p;
      let z = 0;
      for (let j = 0; j < p; j++) z += X[off + j] * w[j];
      const mu = 1 / (1 + Math.exp(-z));
      pr[i] = mu;
      const resid = (mu - y[i]) / n;
      const wt = Math.max(mu * (1 - mu), 1e-8) / n;
      for (let r = 0; r < p; r++) {
        const xr = X[off + r];
        if (xr === 0) continue;
        grad[r] += xr * resid;
        const hr = H[r];
        const wx = wt * xr;
        for (let cc = r; cc < p; cc++) hr[cc] += wx * X[off + cc];
      }
    }
    for (let r = 0; r < p; r++) for (let cc = 0; cc < r; cc++) H[r][cc] = H[cc][r];

    // ridge on the control points only: c = C w, so add k * C'C
    controls(w);
    let cSum = 0;
    for (let j = 0; j < nCtrl; j++) cSum += c[j];
    grad[0] += k * cSum;
    let tail = 0;
    for (let m = nCtrl - 1; m >= 1; m--) { tail += c[m]; grad[m] += -k * tail; }
    for (let r = 0; r < nCtrl; r++) {
      for (let cc = 0; cc < nCtrl; cc++) {
        // C'C entry: number of control points affected by both r and cc
        const rr = r === 0 ? nCtrl : nCtrl - r;
        const ccn = cc === 0 ? nCtrl : nCtrl - cc;
        const shared = Math.min(rr, ccn);
        const sign = (r === 0 ? 1 : -1) * (cc === 0 ? 1 : -1);
        H[r][cc] += k * sign * shared;
      }
    }
    for (let r = 0; r < p; r++) H[r][r] += 1e-9;

    // active set: steps pinned at zero whose gradient pushes them negative
    const free = [];
    for (let j = 0; j < p; j++) {
      const isStep = j >= 1 && j < nCtrl;
      if (isStep && w[j] <= 1e-12 && grad[j] > 0) continue;
      free.push(j);
    }
    if (!free.length) break;

    const Hf = free.map((r) => free.map((cc) => H[r][cc]));
    const inv = matInv(Hf);
    if (!inv) break;
    const step = new Float64Array(p);
    for (let a = 0; a < free.length; a++) {
      let s = 0;
      for (let b = 0; b < free.length; b++) s -= inv[a][b] * grad[free[b]];
      step[free[a]] = s;
    }

    /* Line search. The step is linear in t until a bound clamps, and clamping
       is rare after the first couple of iterations, so cache X w and X step
       once and walk the trial logits in O(n) instead of rebuilding O(n p). */
    for (let i = 0; i < n; i++) {
      const off = i * p;
      let a = 0;
      let b = 0;
      for (let j = 0; j < p; j++) { a += X[off + j] * w[j]; b += X[off + j] * step[j]; }
      zCur[i] = a;
      zStep[i] = b;
    }

    let t = 1;
    let ok = false;
    const trial = new Float64Array(p);
    for (let ls = 0; ls < 20; ls++) {
      let clamped = false;
      for (let j = 0; j < p; j++) {
        let v = w[j] + t * step[j];
        if (j >= 1 && j < nCtrl && v < 0) { v = 0; clamped = true; }
        trial[j] = v;
      }
      let fT;
      if (clamped) {
        fT = nll(trial);
      } else {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const z = zCur[i] + t * zStep[i];
          s += (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z))) - y[i] * z;
        }
        s /= n;
        controls(trial);
        let q2 = 0;
        for (let j = 0; j < nCtrl; j++) q2 += c[j] * c[j];
        fT = s + 0.5 * k * q2;
      }
      if (fT <= fCur + 1e-12) {
        w.set(trial);
        ok = true;
        const gain = fCur - fT;
        fCur = fT;
        if (gain < 1e-11) it = 999;
        break;
      }
      t *= 0.5;
    }
    if (!ok) break;
  }

  return { w, cHi: Float64Array.from(controls(w)), H };
}

/* ---------- distillation: monotone projection onto fewer control points ----------

   Least-squares match of an nLo-point curve to the fitted nHi-point curve,
   with the same non-increasing constraint. Fitting a high-degree curve and
   projecting down beats fitting the low-degree curve directly: the two search
   different spaces, and the projection is scored on an even grid rather than
   weighted by where the data happens to pile up, which regularises the sparse
   regions.

   The integrand is a polynomial, so Gauss-Legendre nodes make this an exact
   integral with a couple of dozen rows rather than an approximation over
   hundreds. */

const GL_CACHE = new Map();
function gaussLegendre(m) {
  if (GL_CACHE.has(m)) return GL_CACHE.get(m);
  const x = new Float64Array(m);
  const wq = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let t = Math.cos((Math.PI * (i + 0.75)) / (m + 0.5));
    let dp = 1;
    for (let it = 0; it < 60; it++) {
      let p0 = 1;
      let p1 = 0;
      for (let j = 0; j < m; j++) { const p2 = p1; p1 = p0; p0 = ((2 * j + 1) * t * p1 - j * p2) / (j + 1); }
      dp = (m * (t * p0 - p1)) / (t * t - 1);
      const dt = -p0 / dp;
      t += dt;
      if (Math.abs(dt) < 1e-15) break;
    }
    x[i] = 0.5 * (t + 1);
    wq[i] = 1 / ((1 - t * t) * dp * dp);
  }
  const out = { x, w: wq };
  GL_CACHE.set(m, out);
  return out;
}

const PROJ_CACHE = new Map();
/** Design for the projection: A maps cHi to node values, M maps [a, s] likewise. */
function projectionNodes(nHi, nLo) {
  const key = `${nHi}:${nLo}`;
  if (PROJ_CACHE.has(key)) return PROJ_CACHE.get(key);
  const m = nHi + nLo + 2;
  const { x, w } = gaussLegendre(m);
  const A = [];
  const M = [];
  const bh = new Float64Array(nHi);
  const bl = new Float64Array(nLo);
  for (let i = 0; i < m; i++) {
    const sw = Math.sqrt(w[i]);
    bernsteinInto(nHi, x[i], bh, 0);
    bernsteinInto(nLo, x[i], bl, 0);
    A.push(Float64Array.from(bh, (v) => v * sw));
    const row = new Float64Array(nLo);
    row[0] = sw;
    let suffix = 0;
    for (let kk = nLo - 1; kk >= 1; kk--) { suffix += bl[kk]; row[kk] = -suffix * sw; }
    M.push(row);
  }
  const out = { A, M, m };
  PROJ_CACHE.set(key, out);
  return out;
}

/**
 * Returns the distilled control points and the linear map from the fitted
 * parameters to them, so coefficient uncertainty can be carried through the
 * projection instead of being thrown away.
 */
function projectMonotone(nodes, cHi, nLo) {
  const { A, M, m } = nodes;
  const target = new Float64Array(m);
  for (let i = 0; i < m; i++) target[i] = dot(A[i], cHi);

  // normal equations with an active set on s >= 0
  const active = new Set();
  let v = new Float64Array(nLo);
  for (let pass = 0; pass < nLo + 2; pass++) {
    const free = [];
    for (let j = 0; j < nLo; j++) if (!active.has(j)) free.push(j);
    if (!free.length) break;
    const G = free.map((r) => free.map((cc) => {
      let s = 0;
      for (let i = 0; i < m; i++) s += M[i][r] * M[i][cc];
      return s;
    }));
    for (let r = 0; r < free.length; r++) G[r][r] += 1e-10;
    const rhs = free.map((r) => {
      let s = 0;
      for (let i = 0; i < m; i++) s += M[i][r] * target[i];
      return s;
    });
    const inv = matInv(G);
    if (!inv) break;
    v = new Float64Array(nLo);
    for (let a = 0; a < free.length; a++) {
      let s = 0;
      for (let b = 0; b < free.length; b++) s += inv[a][b] * rhs[b];
      v[free[a]] = s;
    }
    let worst = -1;
    let worstVal = -1e-12;
    for (let j = 1; j < nLo; j++) if (!active.has(j) && v[j] < worstVal) { worstVal = v[j]; worst = j; }
    if (worst < 0) {
      // linear map from cHi to cLo, holding the active set fixed
      const J = Array.from({ length: nLo }, () => new Float64Array(cHi.length));
      const pinv = free.map((_, a) => {
        const row = new Float64Array(cHi.length);
        for (let b = 0; b < free.length; b++) {
          for (let i = 0; i < m; i++) {
            const coef = inv[a][b] * M[i][free[b]];
            for (let q = 0; q < cHi.length; q++) row[q] += coef * A[i][q];
          }
        }
        return row;
      });
      for (let a = 0; a < free.length; a++) {
        const j = free[a];
        if (j === 0) for (let q = 0; q < cHi.length; q++) for (let kk = 0; kk < nLo; kk++) J[kk][q] += pinv[a][q];
        else for (let kk = j; kk < nLo; kk++) for (let q = 0; q < cHi.length; q++) J[kk][q] -= pinv[a][q];
      }
      const cLo = new Float64Array(nLo);
      cLo[0] = v[0];
      let run = 0;
      for (let j = 1; j < nLo; j++) { run += v[j]; cLo[j] = v[0] - run; }
      return { cLo, J };
    }
    active.add(worst);
  }
  const cLo = new Float64Array(nLo).fill(cHi[0]);
  return { cLo, J: Array.from({ length: nLo }, () => new Float64Array(cHi.length)) };
}

/* ---------- building the model ---------- */

const LEAD_CTRL_HI = 6;    // control points fitted
const LEAD_CTRL_LO = 4;    // control points kept after distillation
const LAMBDA_GRID = [0.003, 0.012, 0.045, 0.17, 0.6];
/* Used when the caller skips the search. Chosen from the six-event grid; it
   sits in the flat part of the LOEO curve, so a page that paints with this and
   refines afterwards shows the same numbers either way in most cases. */
const DEFAULT_LAMBDA = 0.012;

/**
 * Predictors: group booking, registration lead time, distance to the venue.
 *
 * Lead time is a monotone curve rather than a straight line. The straight-line
 * version was significant on the first three events (OR 0.90 per day) and died
 * once July 30 was added, because that event's whole list registered about 37
 * days out and turned out normally. Forcing the curve to be non-increasing and
 * distilling it down keeps the part the data supports, a decline over the
 * first stretch, and refuses to invent a recovery in the far tail that rests
 * on one event.
 *
 * Distance is centred on the training mean before it enters. A family with no
 * usable ZIP therefore contributes exactly zero, which is the average, so the
 * missing field neither helps nor hurts them. This matters because a missing
 * ZIP is not missing at random right now: families added on the back end from
 * a warm referral never see the form, and they attend at a high rate. Centring
 * keeps that out of the model rather than letting distance quietly stand in
 * for acquisition channel. Any event with no venue set contributes nothing to
 * the distance term but still trains group and lead time.
 *
 * Graduation year, GPA, coast, registration order, income and education were
 * all tested across six events and none earned a place.
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
function buildModel(trainRows, opts = {}) {
  const nHi = opts.leadCtrlHi || LEAD_CTRL_HI;
  const nLo = opts.leadCtrlLo || LEAD_CTRL_LO;

  const leads = trainRows.map((r) => r.leadDays);
  const leadMin = Math.min(...leads);
  const leadMax = Math.max(...leads);

  /* Distance. Everything here is derived from the training rows, so adding a
     new event with a venue changes the clamp, the centring and k on the next
     load with nothing to edit by hand. */
  const covered = trainRows.filter((r) => r.miles != null);
  const distEvents = new Set(covered.map((r) => r.eventId)).size;
  const useDist = covered.length >= DIST_MIN_FAMILIES && distEvents >= DIST_MIN_EVENTS;
  const sortedMiles = covered.map((r) => r.miles).sort((a, b) => a - b);
  const distCap = useDist ? Math.max(quantile(sortedMiles, DIST_CLAMP_PCTL), 1) : 0;

  /* k is chosen below by leave-one-event-out; this holds whatever is current. */
  let distK = opts.distK != null ? opts.distK : DEFAULT_DIST_K;
  let distMean = 0;
  const recentre = (rows) => {
    let s = 0;
    let n = 0;
    for (const r of rows) if (r.miles != null) { s += distanceScale(r.miles, distK, distCap); n += 1; }
    distMean = n ? s / n : 0;
  };
  recentre(trainRows);
  const distTerm = (row) => (useDist && row.miles != null
    ? distanceScale(row.miles, distK, distCap) - distMean
    : 0);

  const useGroup = new Set(trainRows.map((r) => r.isGroup)).size > 1;
  const p = nHi + (useGroup ? 1 : 0) + (useDist ? 1 : 0);
  const nodes = projectionNodes(nHi, nLo);

  /* Design in the fitting parametrisation: [1, -(B L), group, distance].
     Packed flat and row-major so the solver walks contiguous memory. */
  const packDesign = (rows, lo, hi) => {
    const X = new Float64Array(rows.length * p);
    const b = new Float64Array(nHi);
    for (let i = 0; i < rows.length; i++) {
      const off = i * p;
      bernsteinInto(nHi, scaleLead(rows[i].leadDays, lo, hi), b, 0);
      X[off] = 1;
      let suffix = 0;
      for (let k = nHi - 1; k >= 1; k--) { suffix += b[k]; X[off + k] = -suffix; }
      let j = nHi;
      if (useGroup) X[off + (j++)] = rows[i].isGroup;
      if (useDist) X[off + j] = distTerm(rows[i]);
    }
    return X;
  };

  const finish = (rows, lambda, warm) => {
    const lo = Math.min(...rows.map((r) => r.leadDays));
    const hi = Math.max(...rows.map((r) => r.leadDays));
    const X = packDesign(rows, lo, hi);
    const y = Float64Array.from(rows, (r) => r.attended);
    const sol = solveMonotone(X, y, rows.length, p, nHi, lambda, warm);
    const { cLo, J } = projectMonotone(nodes, sol.cHi, nLo);

    /* No analytic covariance here, deliberately. Inverting the Hessian gives
       nonsense for this model: the Bernstein columns are collinear by
       construction, and control points pinned at the monotonicity boundary have
       no Gaussian sampling distribution at all. Doing it anyway produced
       standard errors four times the size of the coefficients and a forecast
       that was flat from zero to everybody. Uncertainty comes from resampling
       events instead, further down. */
    const q = nLo + (useGroup ? 1 : 0) + (useDist ? 1 : 0);
    const beta = new Array(q);
    for (let a = 0; a < nLo; a++) beta[a] = cLo[a];
    let j = nHi;
    let bi = nLo;
    if (useGroup) beta[bi++] = sol.w[j++];
    if (useDist) beta[bi] = sol.w[j];

    const design = (row) => {
      const x = new Array(q);
      const b = new Float64Array(nLo);
      bernsteinInto(nLo, scaleLead(row.leadDays, lo, hi), b, 0);
      for (let a = 0; a < nLo; a++) x[a] = b[a];
      let idx = nLo;
      if (useGroup) x[idx++] = row.isGroup;
      if (useDist) x[idx] = distTerm(row);
      return x;
    };

    const terms = [];
    for (let a = 0; a < nLo; a++) terms.push(`lead ${a + 1}/${nLo}`);
    if (useGroup) terms.push('group');
    if (useDist) terms.push('distance');

    const rate = (pred) => {
      const sub = rows.filter(pred);
      return sub.length ? sub.filter((r) => r.attended === 1).length / sub.length : null;
    };

    return {
      beta, design, terms, warm: sol.w, lambda, betaDraws: null,
      leadMin: lo, leadMax: hi, distMean, useDist, useGroup, nLo, nHi,
      n: rows.length,
      soloRate: rate((r) => r.isGroup === 0),
      groupRate: rate((r) => r.isGroup === 1),
      soloN: rows.filter((r) => r.isGroup === 0).length,
      groupN: rows.filter((r) => r.isGroup === 1).length,
      baseRate: rows.length ? rows.filter((r) => r.attended === 1).length / rows.length : null,
    };
  };

  /* Leave one event out to pick the shape penalty. Families inside an event are
     correlated, so a random split would flatter the model. The grid is short and
     each solve warm-starts from the last, which is what keeps this fast. */
  const events = [...new Set(trainRows.map((r) => r.eventId))];
  const makeFolds = (rows) => {
    const folds = events.map((ev) => ({
      train: rows.filter((r) => r.eventId !== ev),
      test: rows.filter((r) => r.eventId === ev),
    })).filter((f) => f.test.length && new Set(f.train.map((r) => r.attended)).size > 1);
    return folds.map((f) => {
      const lo = Math.min(...f.train.map((r) => r.leadDays));
      const hi = Math.max(...f.train.map((r) => r.leadDays));
      return {
        X: packDesign(f.train, lo, hi),
        y: Float64Array.from(f.train, (r) => r.attended),
        n: f.train.length,
        test: f.test, lo, hi, warm: null,
      };
    });
  };

  /* One leave-one-event-out pass at a given penalty. Folds are rebuilt whenever
     k changes, since k moves the distance column. */
  const scoreLambda = (rows, lambda, prepIn) => {
      const prep = prepIn || makeFolds(rows);
      let loss = 0;
      for (const f of prep) {
        const sol = solveMonotone(f.X, f.y, f.n, p, nHi, lambda, f.warm);
        f.warm = sol.w;
        const { cLo } = projectMonotone(nodes, sol.cHi, nLo);
        const gIdx = nHi;
        const bg = useGroup ? sol.w[gIdx] : 0;
        const bd = useDist ? sol.w[gIdx + (useGroup ? 1 : 0)] : 0;
        const b = new Float64Array(nLo);
        let ll = 0;
        for (const r of f.test) {
          bernsteinInto(nLo, scaleLead(r.leadDays, f.lo, f.hi), b, 0);
          let z = bg * r.isGroup + bd * distTerm(r);
          for (let a = 0; a < nLo; a++) z += b[a] * cLo[a];
          const pp = Math.min(Math.max(1 / (1 + Math.exp(-z)), 1e-9), 1 - 1e-9);
          ll += -(r.attended * Math.log(pp) + (1 - r.attended) * Math.log(1 - pp));
        }
        loss += ll / f.test.length;
      }
      return loss / prep.length;
  };

  const chooseLambda = (rows) => {
    if (events.length < 3) return DEFAULT_LAMBDA;
    const prep = makeFolds(rows);
    if (!prep.length) return DEFAULT_LAMBDA;
    let best = null;
    for (const lambda of LAMBDA_GRID) {
      const loss = scoreLambda(rows, lambda, prep);
      if (!best || loss < best.loss) best = { lambda, loss };
    }
    return best.lambda;
  };

  /* k first at a fixed penalty, then the penalty at the chosen k. Searching the
     pair jointly would be 40 combinations rather than 13 for no measurable
     gain, since the two barely interact. */
  const chooseK = (rows) => {
    if (!useDist || events.length < DIST_MIN_EVENTS) return distK;
    const scores = [];
    for (const k of DIST_K_GRID) {
      distK = k;
      recentre(rows);
      scores.push({ k, loss: scoreLambda(rows, DEFAULT_LAMBDA) });
    }
    const best = Math.min(...scores.map((s) => s.loss));
    /* Smallest k within tolerance of the winner, not the winner itself. Once
       miles are clamped, k is only weakly identified: a large k with a large
       coefficient describes the same curve over the observed range as a small
       k with a small one. Preferring the smaller keeps the curvature near the
       venue, where the data is, rather than out where it is not. */
    return (scores.find((s) => s.loss <= best + DIST_K_TOL) || scores[0]).k;
  };

  const cancelled = trainRows.filter((r) => r.status === 'cancelled');
  const remaining = trainRows.filter((r) => r.status !== 'cancelled');

  /* opts.lambda skips the leave-one-event-out search, which is most of the
     cost of a cold load. The intended pattern in app.js is to paint with
     buildModel(rows, { lambda: DEFAULT_LAMBDA }) and then refine in an idle
     callback with a plain buildModel(rows), swapping the numbers only if the
     chosen penalty actually differs. */
  distK = opts.distK != null ? opts.distK : chooseK(trainRows);
  recentre(trainRows);
  const lambda = opts.lambda != null ? opts.lambda : chooseLambda(trainRows);
  const everyone = finish(trainRows, lambda, null);
  const stillOn = finish(remaining.length >= 12 ? remaining : trainRows, lambda, everyone.warm);

  /* ---------- how uncertain the coefficients are ----------

     Resample whole events, with replacement, and refit. Every draw is a real
     constrained fit, so the monotonicity holds in each one and nothing has to
     be approximated by a normal distribution that does not apply.

     Events rather than families, because families inside one event are
     correlated: they saw the same invitation, the same venue, the same weather.
     With a handful of events the dominant question is what a different evening
     would have looked like, and resampling families would badly understate it.

     This replaces an analytic covariance that was producing standard errors
     several times the size of the coefficients themselves, and with them a
     forecast that stretched from nobody to everybody. */
  const bootstrapDraws = (rows, lam, draws, warm) => {
    if (events.length < 2) return null;
    const byEvent = events.map((ev) => rows.filter((r) => r.eventId === ev));
    const rng = mulberry32(20260819);
    const out = [];
    let seed = warm;                 // each refit starts from the last solution
    for (let d = 0; d < draws; d++) {
      const pick = [];
      for (let i = 0; i < events.length; i++) {
        pick.push(...byEvent[Math.floor(rng() * events.length)]);
      }
      if (new Set(pick.map((r) => r.attended)).size < 2) continue;
      try {
        const f = finish(pick, lam, seed);
        seed = f.warm;
        out.push(f.beta);
      } catch (err) { /* a degenerate resample is simply skipped */ }
    }
    return out.length >= 8 ? out : null;
  };

  // Of the extra seats a family booked, how many actually walk in when they come.
  const attending = trainRows.filter((r) => r.attended === 1);
  const extraBooked = attending.reduce((s, r) => s + (r.tickets - 1), 0);
  const extraChecked = attending.reduce((s, r) => s + Math.max(r.ticketsChecked - 1, 0), 0);
  const companionRate = extraBooked > 0 ? Math.min(extraChecked / extraBooked, 1) : 0.9;

  /* A dozen resamples already pin the interval to within a person; the larger
     count in the background pass just smooths its edges. */
  const draws = opts.bootstrap === 0 ? 0 : (opts.bootstrap || 60);
  if (draws) {
    everyone.betaDraws = bootstrapDraws(trainRows, lambda, draws, everyone.warm);
    stillOn.betaDraws = remaining.length >= 12
      ? bootstrapDraws(remaining, lambda, draws, stillOn.warm)
      : everyone.betaDraws;
  }

  return {
    everyone,
    stillOn,
    companionRate,
    lambda,
    bootstrapN: everyone.betaDraws ? everyone.betaDraws.length : 0,
    n: trainRows.length,
    cancelledN: cancelled.length,
    distCoverage: trainRows.length ? covered.length / trainRows.length : 0,
    distN: covered.length,
    distK,
    distCap,
    useDist,
    events,
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
  const p = fit.beta.length;
  const pool = fit.betaDraws && fit.betaDraws.length ? fit.betaDraws : null;
  const rows = families.map((f) => ({ x: fit.design(f), tickets: f.tickets, forced: f.forcedZero }));

  const run = (varyBeta) => {
    const fams = new Array(draws);
    const people = new Array(draws);
    const beta = new Float64Array(p);
    for (let d = 0; d < draws; d++) {
      if (varyBeta && pool) {
        const src = pool[Math.floor(rng() * pool.length)];
        for (let i = 0; i < p; i++) beta[i] = src[i];
      } else {
        for (let i = 0; i < p; i++) beta[i] = fit.beta[i];
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

/** Attach miles to each family, given a venue. Call before buildModel. */
function attachDistance(families, venue) {
  for (const f of families) f.miles = familyMiles(f, venue);
  return families;
}

if (typeof module !== 'undefined') {
  module.exports = {
    TEST_SIGNUPS, norm, isTestSignup, zipToTz, detectTz, eventStartMs, regionForTz,
    buildFamilies, buildModel, predictOne, simulate, interval, sigmoid,
    resolveVenue, haversineMiles, familyMiles, attachDistance, distanceScale,
    LAMBDA_GRID, DEFAULT_LAMBDA, DIST_K_GRID, DEFAULT_DIST_K, DIST_CLAMP_PCTL, quantile,
    ZIP_CENTROIDS, VENUE_ALIASES, TZ_LABEL, TZ_OFFSET,
  };
}
