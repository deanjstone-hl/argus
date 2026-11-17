import { describe, it, expect } from 'vitest';
import { ulid } from '../src/utils/ulid.js';

describe('ulid', () => {
  it('produces a 26-character Crockford base32 string', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('produces unique ids across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(ids.size).toBe(1000);
  });

  it('is lexicographically sortable by timestamp', () => {
    const earlier = ulid(1_000_000);
    const later = ulid(2_000_000);
    expect(earlier < later).toBe(true);
  });
});
