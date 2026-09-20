import { describe, expect, it } from 'vitest';
import { login } from '../src/auth';

describe('login', () => {
  it('rejects a bad password', async () => {
    // comments and formatting do not matter
    const response = await login('alice', 'wrong');
    expect(response.body.error).toEqual(
      'invalid_credentials',
    );
    expect((response.status)).toBe(401);
  });
});
