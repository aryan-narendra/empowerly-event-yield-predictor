# Event yield forecast

A single page dashboard that reads a Luma guest export for an upcoming dinner
and estimates how many people and families will actually walk in, with an honest
uncertainty range.

Everything runs in the browser. Nothing you upload is sent to a server.

## Hosting

This is a static site, so GitHub Pages hosts it for free. No backend, no
database, no paid plan.

1. Push this folder to a repository.
2. Settings, then Pages, then Source: *Deploy from a branch*, `main` / root.
3. Open `https://<user>.github.io/<repo>/`.

Netlify Drop, Cloudflare Pages, and Neocities work the same way.

Opening `index.html` straight off your hard drive will **not** work: browsers
block `fetch` on `file://`, so the past event files cannot load. To run locally:

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
fallback for local servers and for the moments GitHub rate limits the listing,
so it is worth keeping current.

Excel exports work too. Everything else is worked out for you: the event date
comes from the filename, or failing that from when guests were scanned in, and
the time zone comes from registrant ZIP codes. Override either one per event
with `date` or `tz` keys.

A file with no check-ins is skipped with a note, since it cannot teach the model
who showed up. That way an upcoming event dropped in by mistake will not drag
the forecast down.

## Guest data

Raw exports carry names, emails, phone numbers, and ZIP codes. A GitHub Pages
site is public even when the repository is private, so anything in `training/`
is readable by anyone who finds the URL. That is a different thing from a public
registration link: the link lets people sign up, while these files list who did.

If you would rather keep the details off the open web, `tools/anonymize.py`
strips a raw export down to the handful of fields the model actually uses:

```bash
python3 tools/anonymize.py ~/Downloads/export.csv 2026-08-12 \
  --out training/2026-08-12-princeton.csv --event-id "Princeton (Aug 12)"
```

The dashboard reads either format, so you can mix them in the same folder.

## How the forecast works

A logistic regression on past guest lists with a single predictor: whether the
family booked more than one ticket. Solo bookings attend about 37% of the time
and group bookings about 69%.

Several other predictors were tested and dropped. Registration lead time looked
strong across the first three events (odds ratio 0.90 per day, p = 0.004) and
then collapsed once a fourth event was added whose entire guest list registered
about 37 days ahead and turned out normally anyway (p = 0.30). Coast, graduation
year, GPA, distance to the venue and registration order were all tested and none
of them predicted attendance out of sample.

### The cancellation switch

A guest marked not going is almost always the events team recording what they
already know, rather than the guest changing their own mind. Across four events
only two guests ever did it themselves. Because of that, a family's status is
not a fact about the family, it is a fact about how far the team has got through
the list, so the page fits two versions and lets you pick:

- **switch off**, before cancellations have been worked through: nobody is
  counted out, and every family is scored at rates that already allow for the
  cancellations still to come (solo 37%, group 69%);
- **switch on**, once the list is settled: cancelled families are counted out
  and the rest are scored at the higher rate that then applies (solo 55%,
  group 69%).

Using the second set of rates before the cancellations have happened would
overstate turnout by up to a third, which is why the switch defaults to off.

### The range

Two things are uncertain at once:

- **the night itself**, since even with perfect probabilities each family is a
  coin flip, so turnout varies from evening to evening;
- **the model**, since it was fitted on roughly a hundred families, so the
  coefficients themselves are only approximately known.

The page runs 6,000 simulated evenings. Each one draws a fresh set of
coefficients from their uncertainty, then flips a coin per family. The reported
range is the middle 50, 80, 90, 95, 99 or 99.9% of those evenings, and the plot
shows both the combined range and the narrower night only range beneath it.

## Files

```
index.html              page
styles.css              visual system
model.js                parsing, logistic fit, simulation
app.js                  interface
training/manifest.json  which past events to learn from
training/*.csv          past events
tools/anonymize.py      raw Luma export to anonymized training file
```
