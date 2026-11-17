import type { CheckDetail, ServiceCheck } from '@argus/watchtower-contract'

// One labelled line on a card. `title` is the hover text (the absolute time
// behind a relative one); `swatch` a colour chip (printer ink).
export interface DetailRow {
  label: string
  value: string
  title?: string
  tone?: 'warn'
  swatch?: string | null
}

export interface DetailSection {
  title: string
  rows: DetailRow[]
  // What to say when `rows` is empty; a section with neither is not shown.
  empty?: string
}

// What a kind's formatter contributes. Everything is optional: the registry
// fills in the service key as the title and the poller error as the reason.
export interface CardContent {
  title?: string
  // One line under the title on a healthy card, e.g. `up 7d 9h`.
  summary?: string | null
  // Why a non-healthy card is not healthy. Ignored on a healthy card.
  reason?: string | null
  rows?: DetailRow[]
  sections?: DetailSection[]
}

export interface CardView {
  title: string
  summary: string | null
  reason: string | null
  stale: { age: string; at: string } | null
  rows: DetailRow[]
  sections: DetailSection[]
  // The detail as stored, for the optional raw view only.
  raw: string | null
}

// One entry in the registry. A card ticket adds a kind by writing one of
// these and listing it in CARD_FORMATTERS.
export interface CardFormatter {
  id: string
  matches: (check: ServiceCheck) => boolean
  format: (check: ServiceCheck, detail: CheckDetail, now: number) => CardContent
}
