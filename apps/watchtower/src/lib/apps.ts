import { switcherApps } from '@/lib/links'

// The Argus web apps the app switcher lists, the current one included. The registry
// (links.json) owns the list, so a new or retired app changes it in one place.
export const APPS = switcherApps('watchtower')
