import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from './logger.ts';

describe('logger', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const originalLevel = process.env.ORC_LOG_LEVEL;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    logSpy   = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy  = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.ORC_LOG_LEVEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLevel === undefined) {
      delete process.env.ORC_LOG_LEVEL;
    } else {
      process.env.ORC_LOG_LEVEL = originalLevel;
    }
  });

  it('suppresses debug at default warn level', () => {
    logger.debug('should not appear');
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('suppresses info at default warn level', () => {
    logger.info('should not appear');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('shows warn at default level', () => {
    logger.warn('visible warning');
    expect(warnSpy).toHaveBeenCalledWith('visible warning');
  });

  it('shows error at default level', () => {
    logger.error('visible error');
    expect(errorSpy).toHaveBeenCalledWith('visible error');
  });

  it('respects ORC_LOG_LEVEL=debug to show all levels', () => {
    process.env.ORC_LOG_LEVEL = 'debug';
    logger.debug('debug msg');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');
    expect(debugSpy).toHaveBeenCalledWith('debug msg');
    expect(logSpy).toHaveBeenCalledWith('info msg');
    expect(warnSpy).toHaveBeenCalledWith('warn msg');
    expect(errorSpy).toHaveBeenCalledWith('error msg');
  });

  it('respects ORC_LOG_LEVEL=silent to suppress all output', () => {
    process.env.ORC_LOG_LEVEL = 'silent';
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('falls back to warn for invalid ORC_LOG_LEVEL value', () => {
    process.env.ORC_LOG_LEVEL = 'bogus';
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('w');
    expect(errorSpy).toHaveBeenCalledWith('e');
  });
});
