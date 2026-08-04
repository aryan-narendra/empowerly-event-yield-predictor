#!/usr/bin/env python3
"""
Convert a raw Luma guest export into an anonymized training file.

Usage:
    python tools/anonymize.py raw_export.csv 2026-06-30 --out training/2026-06-30-san-jose.csv

The date is the event date (local). The event is assumed to start at 6:00 PM
local time; the local time zone is inferred from registrant ZIP codes.

The output contains no names, emails, phone numbers, schools, or ZIP codes:
only the fields the forecasting model actually uses. Keep raw exports out of
any repository you publish.
"""
import argparse
import csv
import re
import sys
from datetime import datetime, timedelta, timezone

EXCLUDED_NAMES = {
    "aryan narendra", "theresa shropshire", "anish gupta", "anvi gupta",
    "ethan klets", "alison hamilton", "bethany liu", "saawan duvvuri",
    "changxiao xie", "jerry wei",
}

# ZIP prefix (first 3 digits) -> time zone. Ranges are inclusive.
ZIP_TZ = [
    (10, 89, "ET"), (100, 199, "ET"), (200, 349, "ET"), (350, 369, "CT"),
    (370, 385, "CT"), (386, 397, "CT"), (398, 399, "ET"), (400, 427, "ET"),
    (430, 499, "ET"), (500, 567, "CT"), (570, 588, "CT"), (590, 599, "MT"),
    (600, 693, "CT"), (700, 799, "CT"), (800, 847, "MT"), (850, 865, "MST"),
    (870, 884, "MT"), (889, 898, "PT"), (900, 961, "PT"), (967, 968, "HST"),
    (970, 994, "PT"), (995, 999, "AKT"),
]
TZ_OFFSET = {"ET": -5, "CT": -6, "MT": -7, "MST": -7, "PT": -8, "AKT": -9, "HST": -10}
NO_DST = {"MST", "HST"}
EAST_TZ = {"ET"}


def zip_tz(zip_code):
    m = re.match(r"\s*(\d{3})", str(zip_code or ""))
    if not m:
        return None
    p = int(m.group(1))
    for lo, hi, tz in ZIP_TZ:
        if lo <= p <= hi:
            return tz
    return None


def dst_active(tz, dt):
    if tz in NO_DST:
        return False
    year = dt.year
    march = datetime(year, 3, 8)
    second_sunday = march + timedelta(days=(6 - march.weekday()) % 7)
    nov = datetime(year, 11, 1)
    first_sunday = nov + timedelta(days=(6 - nov.weekday()) % 7)
    return second_sunday <= dt < first_sunday


def event_start_utc(date_str, tz):
    y, m, d = (int(x) for x in date_str.split("-"))
    local = datetime(y, m, d, 18, 0)
    offset = TZ_OFFSET[tz] + (1 if dst_active(tz, local) else 0)
    return (local - timedelta(hours=offset)).replace(tzinfo=timezone.utc)


def norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("infile")
    ap.add_argument("date", help="event date, YYYY-MM-DD (local)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--tz", help="override detected time zone (ET/CT/MT/PT/...)")
    ap.add_argument("--event-id", help="label for this event; defaults to the date")
    args = ap.parse_args()

    with open(args.infile, newline="", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))

    kept = []
    for r in rows:
        name = norm(r.get("name") or f"{r.get('first_name','')} {r.get('last_name','')}")
        email = norm(r.get("email"))
        if name in EXCLUDED_NAMES or "empowerly" in email:
            continue
        kept.append(r)

    tzs = [t for t in (zip_tz(r.get("Zip code")) for r in kept) if t]
    tz = args.tz or (max(set(tzs), key=tzs.count) if tzs else "PT")
    start = event_start_utc(args.date, tz)
    region = "East" if tz in EAST_TZ else "West"

    families = {}
    for r in kept:
        key = norm(r.get("email")) or norm(r.get("name"))
        created = datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))
        fam = families.setdefault(key, {"n": 0, "first": created, "checked": 0, "statuses": []})
        fam["n"] += 1
        fam["first"] = min(fam["first"], created)
        fam["statuses"].append(norm(r.get("approval_status")))
        if (r.get("checked_in_at") or "").strip():
            fam["checked"] += 1

    event_id = args.event_id or args.date
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["event_id", "region", "tickets", "lead_days", "attended",
                    "tickets_checked", "cancelled"])
        for fam in families.values():
            lead = (start - fam["first"]).total_seconds() / 86400
            cancelled = 1 if all(s == "declined" for s in fam["statuses"]) else 0
            w.writerow([
                event_id, region, fam["n"], round(lead, 4),
                1 if fam["checked"] > 0 else 0, fam["checked"], cancelled,
            ])

    print(f"{args.out}: {len(families)} families, tz={tz}, region={region}, "
          f"start={start.isoformat()}", file=sys.stderr)


if __name__ == "__main__":
    main()
