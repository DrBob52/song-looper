import { describe, expect, it } from 'vitest';
import { formatTime, parseTime } from '../../src/util/time';

describe('formatTime', () => {
  it('formats minutes and seconds', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(599.4)).toBe('9:59');
  });
  it('formats hours', () => {
    expect(formatTime(3725)).toBe('1:02:05');
  });
  it('formats tenths', () => {
    expect(formatTime(5.26, 1)).toBe('0:05.3');
    expect(formatTime(75.04, 1)).toBe('1:15.0');
  });
  it('clamps invalid input', () => {
    expect(formatTime(-3)).toBe('0:00');
    expect(formatTime(NaN)).toBe('0:00');
  });
});

describe('parseTime', () => {
  it('parses mm:ss', () => {
    expect(parseTime('3:30')).toBe(210);
    expect(parseTime('0:05')).toBe(5);
    expect(parseTime('12:00')).toBe(720);
  });
  it('parses plain seconds and h:mm:ss', () => {
    expect(parseTime('90')).toBe(90);
    expect(parseTime('1:00:00')).toBe(3600);
  });
  it('rejects garbage', () => {
    expect(parseTime('')).toBeNull();
    expect(parseTime('abc')).toBeNull();
    expect(parseTime('1:2:3:4')).toBeNull();
    expect(parseTime('-1:00')).toBeNull();
  });
});
