import { describe, expect, it } from 'vitest';
import { formatClock, formatClockFloor, formatTime, parseClock, parseTime, roundMs } from '../../src/util/time';

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

describe('parseClock (exact loop times)', () => {
  it('accepts every documented format', () => {
    expect(parseClock('1:09.600')).toBeCloseTo(69.6, 9);
    expect(parseClock('1:09')).toBe(69);
    expect(parseClock('69.6')).toBeCloseTo(69.6, 9);
    expect(parseClock('69')).toBe(69);
    expect(parseClock('9.6')).toBeCloseTo(9.6, 9);
    expect(parseClock('0:00.001')).toBeCloseTo(0.001, 9);
    expect(parseClock('1:02:03.456')).toBeCloseTo(3723.456, 9);
    expect(parseClock('1:02:03')).toBe(3723);
    expect(parseClock('6:45:47')).toBe(24347);
    expect(parseClock('90:00')).toBe(5400); // minutes may run past 59 without an hour field
    expect(parseClock('.5')).toBe(0.5);
    expect(parseClock('  2:30  ')).toBe(150);
    expect(parseClock('0')).toBe(0);
  });

  it('rejects junk', () => {
    for (const bad of ['', '  ', 'abc', 'soon', '1:2:3:4', '-1', '-1:00', '+5', '1e3', '1:75', '1:60', '0:1:60', '1:61:00', '1::2', ':30', '1:', '1,5', '1.2.3', '1:09.', '0x10', '∞', '1 : 30']) {
      expect(parseClock(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('round-trips the display format to the millisecond', () => {
    for (const seconds of [0, 0.001, 0.4999, 1, 9.6, 59.9994, 59.9995, 60, 69.6, 125.3, 599.999, 3599.9996, 3600, 3723.456, 24347.884]) {
      const text = formatClock(seconds);
      expect(text).toMatch(/^\d+(:\d\d)?:\d\d\.\d{3}$/);
      const back = parseClock(text);
      expect(back, text).not.toBeNull();
      expect(Math.abs(back! - seconds)).toBeLessThanOrEqual(0.0005 + 1e-9);
      // and the text is stable: formatting what was parsed gives the same text
      expect(formatClock(roundMs(back!))).toBe(text);
    }
  });
});

describe('formatClock', () => {
  it('shows minutes, seconds and milliseconds, and hours from one hour up', () => {
    expect(formatClock(0)).toBe('0:00.000');
    expect(formatClock(69.6)).toBe('1:09.600');
    expect(formatClock(83.0004)).toBe('1:23.000');
    expect(formatClock(3723.456)).toBe('1:02:03.456');
    expect(formatClock(86399.9996)).toBe('24:00:00.000');
  });
  it('rounds up into the next unit instead of printing 60 seconds', () => {
    expect(formatClock(59.9996)).toBe('1:00.000');
    expect(formatClock(3599.9999)).toBe('1:00:00.000');
  });
  it('takes other precisions and clamps nonsense', () => {
    expect(formatClock(69.64, 1)).toBe('1:09.6');
    expect(formatClock(69.5, 0)).toBe('1:10');
    expect(formatClock(-3)).toBe('0:00.000');
    expect(formatClock(NaN)).toBe('0:00.000');
  });
  it('rounds down for "at most" values', () => {
    expect(formatClockFloor(24347.884)).toBe('6:45:47');
    expect(formatClockFloor(59.99)).toBe('0:59');
    expect(formatClockFloor(125)).toBe('2:05');
  });
});

describe('roundMs', () => {
  it('rounds to whole milliseconds', () => {
    expect(roundMs(69.6004)).toBe(69.6);
    expect(roundMs(69.6006)).toBe(69.601);
    expect(roundMs(0)).toBe(0);
  });
});
