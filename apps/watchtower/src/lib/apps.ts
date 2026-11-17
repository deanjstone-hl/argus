export interface AppEntry {
  id: string
  name: string
  href: string
  description: string
}

// The Argus web apps the app switcher lists, the current one included.
export const APPS: AppEntry[] = [
  { id: 'watchtower', name: 'Watchtower', href: 'https://watchtower.myargus.cc', description: 'Infra health, live from the collector' },
  { id: 'ops', name: 'Ops hub', href: 'https://ops.myargus.cc', description: 'Issues, PRs, waves and the notice board' },
  { id: 'mail', name: 'Mail', href: 'https://mail.myargus.cc', description: 'The shared agent inbox' },
  { id: 'myargus', name: 'myargus', href: 'https://myargus.cc', description: 'Portal, plans and the system map' },
]
