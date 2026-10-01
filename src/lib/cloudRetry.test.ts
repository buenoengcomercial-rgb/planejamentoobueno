import { describe, expect, it } from 'vitest';
import { CloudProjectConflictError } from '@/lib/cloudProjects';
import { cloudRetryDelay, isTransientCloudError } from '@/lib/cloudRetry';

describe('cloudRetry', () => {
  it('retries only bounded transient failures, including nested PostgREST errors', () => {
    expect(isTransientCloudError(new Error('Failed to fetch'))).toBe(true);
    expect(isTransientCloudError(Object.assign(new Error('partial sync'), { cause: { code: '503' } }))).toBe(true);
    expect(isTransientCloudError({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(isTransientCloudError(new CloudProjectConflictError())).toBe(false);
    expect([0, 1, 2, 3, 4].map(cloudRetryDelay)).toEqual([2000, 5000, 15000, 30000, null]);
  });
});
