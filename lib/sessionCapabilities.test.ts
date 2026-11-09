import { describe, expect, it } from 'vitest';
import { SESSION_CAPABILITIES, sessionCapabilities, transportOfHandle } from './sessionCapabilities.ts';
import { hasSessionStartHook } from './providers.ts';
import { providerSupportsResume } from './sessionResume.ts';

describe('sessionCapabilities', () => {
  it('gives each provider and transport its capabilities', () => {
    expect(sessionCapabilities('claude', 'tmux')).toEqual({
      resume: true, conversation_id: 'orc', attach: true, terminal_input: true, readiness_hook: 'always', can_be_master: true,
    });
    expect(sessionCapabilities('codex', 'tmux')).toEqual({
      resume: false, conversation_id: 'provider', attach: true, terminal_input: true, readiness_hook: 'full-access', can_be_master: true,
    });
    expect(sessionCapabilities('codex', 'app-server')).toEqual({
      resume: true, conversation_id: 'provider', attach: false, terminal_input: false, readiness_hook: 'never', can_be_master: false,
    });
    expect(sessionCapabilities('gemini', 'tmux')).toEqual({
      resume: false, conversation_id: null, attach: true, terminal_input: true, readiness_hook: 'never', can_be_master: true,
    });
  });

  it('gives an unknown provider, transport or a legacy pty session nothing', () => {
    const none = { resume: false, conversation_id: null, attach: false, terminal_input: false, readiness_hook: 'never', can_be_master: false };
    for (const [provider, transport] of [['claude', 'pty'], ['claude', null], ['gemini', 'app-server'], ['other', 'tmux'], [null, 'tmux']]) {
      expect(sessionCapabilities(provider, transport)).toEqual(none);
    }
  });

  it('returns a copy callers can change without touching the table', () => {
    const caps = sessionCapabilities('claude', 'tmux');
    caps.resume = false;
    expect(sessionCapabilities('claude', 'tmux').resume).toBe(true);
    expect(Object.isFrozen(SESSION_CAPABILITIES.claude.tmux)).toBe(true);
  });

  it('is what the resume and readiness rules read', () => {
    for (const [provider, transports] of Object.entries(SESSION_CAPABILITIES)) {
      for (const [transport, caps] of Object.entries(transports)) {
        expect(providerSupportsResume(provider, transport)).toBe(caps.resume);
      }
    }
    expect(hasSessionStartHook('claude', 'sandbox')).toBe(true);
    expect(hasSessionStartHook('codex', 'full-access')).toBe(true);
    expect(hasSessionStartHook('codex', 'sandbox')).toBe(false);
    expect(hasSessionStartHook('gemini', 'full-access')).toBe(false);
    expect(hasSessionStartHook(null, 'full-access')).toBe(false);
  });
});

describe('transportOfHandle', () => {
  it('reads the transport from a session handle', () => {
    expect(transportOfHandle('tmux:worker-a')).toBe('tmux');
    expect(transportOfHandle('app:worker-a')).toBe('app-server');
    expect(transportOfHandle('pty:worker-a')).toBeNull();
    expect(transportOfHandle(null)).toBeNull();
  });
});
