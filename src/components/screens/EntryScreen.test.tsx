import { describe, expect, it, vi } from 'vitest';
import { EntryDoor } from './EntryScreen';

/**
 * The floor, asserted as a contract rather than as a demonstration.
 *
 * React's ability to catch a render error is React's to test. What is OURS is
 * what the boundary does with one: fail closed to `null`, so the door
 * disappears and the already-mounted game underneath is what the visitor is
 * left with — never a blank page in front of a working game.
 *
 * The other half of the promise is that no choice is recorded on failure. That
 * is visible here as an absence: the boundary has no access to the storage
 * module at all, so it cannot decide for the visitor even by accident.
 */

const props = {
  onConnect: async () => ({ kind: 'rejected' }) as const,
  onGuest: () => {},
  onWalletChosen: () => {},
};

describe('the entry door boundary', () => {
  it('fails closed rather than blank', () => {
    expect(EntryDoor.getDerivedStateFromError()).toEqual({ failed: true });

    const door = new EntryDoor(props);
    door.state = { failed: true };
    expect(door.render()).toBeNull();
  });

  it('says so once, where a developer will look', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    new EntryDoor(props).componentDidCatch(new Error('boom'));
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/falling through to guest play/);
    spy.mockRestore();
  });

  it('renders the screen when nothing has gone wrong', () => {
    const door = new EntryDoor(props);
    expect(door.render()).not.toBeNull();
  });
});
