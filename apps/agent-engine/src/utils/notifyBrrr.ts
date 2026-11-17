const BRRR_URL = 'https://api.brrr.now/v1/send';

// `critical` is deliberately absent: it must never be sent without the user's
// explicit permission in that conversation.
export type BrrrLevel = 'passive' | 'active' | 'time-sensitive';

// filter_criteria + sound per docs/reference/brrr.md's "Notification classes".
const CLASS_BY_LEVEL: Record<BrrrLevel, { filter: string; sound: string }> = {
  passive: { filter: 'done', sound: 'bubbly_success_ding' },
  active: { filter: 'failure', sound: 'warm_soft_error' },
  'time-sensitive': { filter: 'failure', sound: 'warm_soft_error' },
};

export async function notifyBrrr(
  message: string,
  level: BrrrLevel = 'passive',
  thread = 'agent-engine'
): Promise<void> {
  const secret = process.env.BRRR_WEBHOOK_SECRET;
  if (!secret) return;

  const { filter, sound } = CLASS_BY_LEVEL[level];

  // brrr is a best-effort supplementary channel: log failures, never let them
  // break task execution.
  try {
    const response = await fetch(BRRR_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        interruption_level: level,
        thread_id: thread,
        title: 'agent-engine',
        filter_criteria: filter,
        sound,
      }),
    });
    if (!response.ok) {
      console.error(`notifyBrrr: brrr responded ${response.status}`);
    }
  } catch (error) {
    console.error('notifyBrrr: send failed:', error);
  }
}
