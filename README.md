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
than it keeps and then projected down onto fewer, which regularizes the sparse
stretches better than fitting the short curve directly.

**Travel distance** is straight-line miles from a family's ZIP to the venue. It
needs venue coordinates in `training/manifest.json`, and it switches itself off
when too few families can be located. Three things about it are worth knowing:

- Distances are **capped** at the far edge of what past guest lists covered, so a
  family further out is scored as if they lived at that edge. Without a cap a
  mistyped ZIP is scored at effectively zero probability. One past guest entered
  a ZIP 1,800 miles away and attended.
- The effect is **centered**, so a family with no ZIP on file sits at the average
  travel effect and is neither rewarded nor penalized for the blank field.
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

Uploading an event that has already happened also switches "Take “not going”
replies at their word" on for you, since a finished event has had its
cancellations worked through by definition. A note says so, and the switch can
be turned straight back off; it is set once per upload rather than forced on
every redraw.

If the file you upload is an event that has already happened, a red rule is
drawn on both histograms at the real outcome, with a note saying whether it
landed inside the range or outside it. Nothing is drawn for an event with no
check-ins, since there is no outcome yet.

The page then runs 6,000 simulated evenings. Each one picks a refit at random
and flips a coin per family. The reported range is the middle
50/80/90/95/99/99.9% of those evenings, and the plot shows both the combined
range and the narrower night-only range beneath it.

Lead time is capped at the longest lead the past events covered, so a list that
opened months early is scored at that edge rather than extrapolated past it.

### Two-stage fit

Two tuning constants can be chosen by leave-one-event-out: the penalty on the
lead curve's shape and the constant in the distance transform. Families inside
one event are correlated, so a random split would flatter the model.

**Both searches are off below eight events, and at six they are off.** Measured
on the six events currently in `training/`, choosing the shape penalty per fold
scored 0.5724 against 0.5598 for the pinned default, with mean headcount error
4.25 against 3.55. The inner leave-one-event-out runs on five events, which is
too few to separate one penalty from another, so it fits fold noise. The
distance constant is worse still: log loss moves by 0.002 across the whole grid
from k=3 to k=60, so the search is choosing between values the data cannot
distinguish. The code is kept because the argument reverses once the inner
split has enough events to mean something.

That search is most of the cost of a page load, so the page fits twice. The
first fit holds both constants at their defaults and lands in tens of
milliseconds, which is what you see. The second runs the search in an idle
callback and swaps in only if it lands somewhere different.

The distance constant is only weakly identified: once distances are capped, a
large constant with a large coefficient describes the same curve as a small one
with a small coefficient. Selection therefore takes the smallest value within a
tolerance of the best score rather than the outright winner, which keeps the
curve on the conservative side of a question the data cannot settle.

## Reading the page

**Registrations over time** counts down to the event: the first sign-up on the
left, the doors opening at zero on the right. Green is everyone who registered,
brass the subset whose final status is approved. Whichever matters less to the
current forecast is washed out and drawn underneath, so ticking "Count guests
awaiting approval" swaps the emphasis.

A registration is an instant, so the line steps rather than slopes: flat until
someone signs up, then straight up by one. It stops at the present moment
instead of running on to the event, and the endpoint carries a dot. While the
list is still open that dot has a ring breathing behind it; once the event has
happened the ring is gone and the line reaches the right edge.

One caveat on that chart. Luma records no timestamp for approval, so the brass
line places each approved family at the moment they registered rather than the
moment they were waved through. It shows what the list was made of, not how
fast the approval queue moved.

**Party size** sits beside it, breaking the list into families who booked one
seat, two, three and so on.

**Every family** gains an attended column, showing check-ins over tickets
booked, only once the event has happened. An upcoming list has nothing to put
there, so the column is left out rather than filled with dashes.

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

For the **upcoming event**, use the "Where it is" box on the page. Any US ZIP
works, as does a past venue name or a coordinate pair, and the box tells you
what it resolved to so a wrong guess is visible before it reaches the forecast.
A full street address works too: the last five-digit run wins, so a house
number that happens to be a real ZIP elsewhere does not hijack the lookup.
Lookup is entirely local, so nothing about an unannounced event leaves the
browser.

ZIP centroids for all 42,555 US ZIP codes live in `zips.js`, so a new market
works at full distance coverage from its first event with nothing to add by
hand. A ZIP that is not a real ZIP still yields no distance, and that family is
scored at the average travel effect.

The table is packed rather than written out as an object. Records are sorted by
ZIP and grouped by the first three digits, with a 1,001-entry directory in
front, so a lookup jumps to its group and scans at most 99 records. Latitude
and longitude are three base-64 characters each, which puts the worst
round-trip error near 390 feet, far below what a ZIP centroid can resolve in
the first place. The file is 335 KB, about 214 KB gzipped, and nothing is
parsed at load: lookups read the string directly, so there is no startup cost
and no 42,555-entry object in memory.

Regenerate it from the npm `zipcodes` package if the table ever needs
refreshing.

## Files

```
index.html            page
styles.css            visual system
zips.js               packed US ZIP centroid table
model.js              parsing, logistic fit, simulation
app.js                interface
training/manifest.json  which past events to learn from
training/*.csv        anonymized past events
tools/anonymize.py    raw Luma export -> anonymized training file
```
