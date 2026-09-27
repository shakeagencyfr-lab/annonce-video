Synthetic fixtures for the listing readers (lib/readers). They are shaped like the
structures described by public 2025-2026 scrapers and fixtures (AutoScout24
`__NEXT_DATA__` / `listingDetails`, Leboncoin `props.pageProps.ad`), not saved from
the platforms: every name, number, id and photo URL is made up, and the phone number
is in a range reserved for fiction. Test use only, never served.

- `autoscout24-listing.html`: an AutoScout24.fr listing page with its `__NEXT_DATA__`
  blob (escaped as Next.js does), a photo of a similar ad and a foreign image URL.
- `leboncoin-auto-export.json`, `leboncoin-immo-export.json`: files as downloaded by
  the export bookmarklet (tools/leboncoin-export.js), one car and one house for sale.
  The car has a non-hex photo id (`gh…`), a duplicate photo, a foreign photo host and
  both the fiscal (`horsepower`) and DIN (`horse_power_din`) power.
