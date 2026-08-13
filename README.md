# Event yield forecast

A single-page dashboard that reads a Luma guest export for an upcoming dinner
and estimates how many people and families will actually walk in, with an
honest uncertainty range.

Everything runs in the browser. Nothing you upload is sent to a server.

## Hosting

This is a static site, so **GitHub Pages hosts it for free**. No backend, no
database, no paid plan.

1. Push this folder to a repository.
2. Settings → Pages → Source: *Deploy from a branch* → `main` / `root`.
3. Open `https://<user>.github.io/<repo>/`.

Netlify Drop, Cloudflare Pages, and Neocities work the same way.

Opening `index.html` straight off your hard drive will **not** work: browsers
block `fetch` on `file://`, so the past-event files can't load. To run locally:

```bash
python3 -m http.server 8000    # then visit http://localhost:8000
```

## Adding a finished event

After an event, export the guest list from Luma and drop the file into
`training/`. Name it starting with the event date:

```
training/2026-08-12-princeton.csv
```

Then add one line to `training/manifest.json`:

```json
{ "file": "2026-08-12-princeton.csv", "label": "Princeton (Aug 12)" }
```

The model refits on the next page load, and more events means tighter ranges.

On GitHub Pages the folder is also read straight from the repo, so a file you
push is picked up even if you forget the manifest line. The manifest is the
fallback for local servers and for the moments GitHub rate-limits the listing,
so it is worth keeping current.

Excel exports work too. Everything else is worked out for you: the event date
comes from the filename, or failing that from when guests were scanned in; the
time zone comes from registrant ZIP codes; East or West coast follows from the
time zone. Override any of it per event with `date`, `tz`, or `region` keys.

A file with no check-ins is skipped with a note, since it can't teach the model
who showed up. That way an upcoming event dropped in by mistake won't drag the
forecast down.

## Guest data

Raw exports carry names, emails, phone numbers, and ZIP codes. A GitHub Pages
site is public even when the repository is private, so anything in `training/`
is readable by anyone who finds the URL. That is a different thing from a public
registration link: the link lets people sign up, while these files list who did.

If you would rather keep the details off the open web, `tools/anonymize.py`
strips a raw export down to the four fields the model actually uses:

```bash
python3 tools/anonymize.py ~/Downloads/export.csv 2026-08-12 \
  --out training/2026-08-12-princeton.csv --event-id "Princeton (Aug 12)"
```

The dashboard reads either format, so you can mix them in the same folder.

## How the forecast works

A logistic regression on past guest lists with three predictors: whether a
family booked more than one ticket, how far ahead they registered, and how far
they live from the venue.

**Group booking** is the strongest and steadiest of the three. Across six events
it has pointed the same way every time.

**Lead time** is a curve that is only allowed to fall, never rise. A
straight-line version looked convincing on the first three events and collapsed
once a fourth was added, because that event's whole list registered about five
weeks out and turned out normally. The curve is fitted with more control points
than it keeps and then projected down onto fewer, which regularises the sparse
stretches better than fitting the short curve directly.

**Travel distance** is straight-line miles from a family's ZIP to the venue. It
needs venue coordinates in `training/manifest.json`, and it switches itself off
when too few families can be located. Three things about it are worth knowing:

- Distances are **capped** at the far edge of what past guest lists covered, so a
  family further out is scored as if they lived at that edge. Without a cap a
  mistyped ZIP is scored at effectively zero probability. One past guest entered
  a ZIP 1,800 miles away and attended.
- The effect is **centred**, so a family with no ZIP on file sits at the average
  travel effect and is neither rewarded nor penalised for the blank field.
- The cap and the curve's steepness are both **worked out from the training
  files** rather than hardcoded, so they move as events are added.

Graduation year, GPA, coast, registration order, income and education were all
tested across six events and none earned a place.

Everything the model needs is derived from the files in `training/`, including
the share of extra seats that actually walk in. There is nothing to retune by
hand when a new event is added.

The range combines two separate uncertainties:

- **the night itself** - even with perfect probabilities, each family is a coin
  flip, so turnout varies from evening to evening;
- **the model** - it was fitted on a handful of events, so the coefficients
  themselves are only approximately known.

The second is measured by refitting the entire model on events resampled with
replacement, sixty times, and keeping the coefficients from each. Whole events
are resampled rather than individual families: families at one dinner shared an
invitation, a venue and an evening, so treating them as independent draws would
make the model look far surer of itself than it is.

Every resample is a real constrained fit, so monotonicity holds in each one.
This replaced an analytic covariance from the inverted Hessian, which does not
work for this model. The Bernstein columns are collinear by construction, and
control points sitting at the monotonicity boundary have no normal sampling
distribution at all. Inverting that matrix produced standard errors several
times the size of the coefficients, and a forecast that ran flat from nobody to
everybody.

The page then runs 6,000 simulated evenings. Each one picks a refit at random
and flips a coin per family. The reported range is the middle
50/80/90/95/99/99.9% of those evenings, and the plot shows both the combined
range and the narrower night-only range beneath it.

Lead time is capped at the longest lead the past events covered, so a list that
opened months early is scored at that edge rather than extrapolated past it.

### Two-stage fit

Two tuning constants are chosen by leave-one-event-out: the penalty on the lead
curve's shape and the constant in the distance transform. Families inside one
event are correlated, so a random split would flatter the model.

That search is most of the cost of a page load, so the page fits twice. The
first fit holds both constants at their defaults and lands in tens of
milliseconds, which is what you see. The second runs the search in an idle
callback and swaps in only if it lands somewhere different.

The distance constant is only weakly identified: once distances are capped, a
large constant with a large coefficient describes the same curve as a small one
with a small coefficient. Selection therefore takes the smallest value within a
tolerance of the best score rather than the outright winner, which keeps the
curve on the conservative side of a question the data cannot settle.

## Setting the venue

Two places, both optional but worth filling in.

For **past events**, add coordinates to the manifest entry:

```json
{
  "file": "2026-08-12-san-jose.csv",
  "label": "San Jose (Aug 12)",
  "venue": "Maggiano's Little Italy, 3055 Olin Ave, San Jose",
  "lat": 37.3210,
  "lon": -121.9475
}
```

`venue` is free text for humans. `lat` and `lon` are what the model reads. Look
the venue up in any map app, right-click the pin, and paste the pair. An event
with no coordinates still teaches group booking and lead time; it just sits out
of the distance term.

For the **upcoming event**, use the "Where it is" box on the page. It accepts a
venue name, a city, a ZIP code, or a coordinate pair, and it tells you what it
resolved to. Lookup is entirely local, so nothing about an unannounced event
leaves the browser.

ZIP centroids are built into `model.js` for every ZIP seen so far. An unfamiliar
ZIP yields no distance and that family is scored at the average travel effect,
so new markets work immediately and get sharper once their ZIPs are added.

## Files

```
index.html            page
styles.css            visual system
model.js              parsing, logistic fit, simulation
app.js                interface
training/manifest.json  which past events to learn from
training/*.csv        anonymized past events
tools/anonymize.py    raw Luma export -> anonymized training file
```
