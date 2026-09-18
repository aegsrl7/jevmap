// Shared helpers for dates and strings.
export interface Options {
  locale: string;
}

/** Formats dates for the UI. */
export class DateFormatter {
  private locale = 'en-GB';

  // Short date, e.g. 18/09/2026.
  format(d: Date): string {
    return d.toLocaleDateString(this.locale);
  }

  // Relative time, e.g. "3 days ago".
  relative(d: Date, now: Date = new Date()): string {
    const days = Math.round((now.getTime() - d.getTime()) / 86400000);
    return `${days} days ago`;
  }
}

// Capitalise the first letter.
export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
