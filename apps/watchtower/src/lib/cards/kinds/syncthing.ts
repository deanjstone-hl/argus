import type { SyncthingFolderDetail } from '@argus/watchtower-contract'
import { list, num } from '../fields'
import type { CardFormatter, DetailRow } from '../types'
import { pluralise } from '../units'

function folderRow(folder: SyncthingFolderDetail): DetailRow {
  const parts = [folder.state]
  if (folder.errors > 0) parts.push(pluralise(folder.errors, 'error'))
  if (folder.needTotalItems > 0) parts.push(`${folder.needTotalItems} pending`)
  const settled = folder.state === 'idle' && folder.errors === 0 && folder.needTotalItems === 0
  return { label: folder.id, value: parts.join(' · '), ...(settled ? {} : { tone: 'warn' as const }) }
}

export const syncthingFormatter: CardFormatter = {
  id: 'syncthing',
  matches: (check) => check.service_key === 'syncthing',
  format: (_check, detail) => {
    const folders = list<SyncthingFolderDetail>(detail, 'folders')
    const errors = num(detail, 'totalErrors') ?? 0
    const outOfSync = num(detail, 'totalOutOfSync') ?? 0
    const erroring = folders.filter((folder) => folder.errors > 0).map((folder) => folder.id)
    const behind = folders.filter((folder) => folder.needTotalItems > 0).map((folder) => `${folder.id} ${folder.state}`)
    const reasons = [
      errors > 0 ? `${pluralise(errors, 'folder error')}: ${erroring.join(', ')}` : null,
      outOfSync > 0 ? `${pluralise(outOfSync, 'item')} out of sync: ${behind.join(', ')}` : null,
    ].filter(Boolean)
    return {
      title: 'Syncthing',
      summary: folders.length > 0 ? `${pluralise(folders.length, 'folder')} in sync` : null,
      reason: reasons.length > 0 ? reasons.join('; ') : null,
      sections: folders.length > 0 ? [{ title: 'Folders', rows: folders.map(folderRow) }] : [],
    }
  },
}
