export interface ScanResult {
  safe: boolean;
  findings: string[];
}

// Invisible / zero-width / bidi override codepoints
const INVISIBLE_RANGES: Array<[number, number, string]> = [
  [0x00AD, 0x00AD, 'soft hyphen'],
  [0x200B, 0x200D, 'zero-width space/non-joiner/joiner'],
  [0x202A, 0x202E, 'bidi embedding/override'],
  [0x2028, 0x2029, 'line/paragraph separator'],
  [0x2066, 0x2069, 'bidi isolate'],
  [0xFEFF, 0xFEFF, 'BOM/zero-width no-break space'],
];

const INJECTION_PHRASES: string[] = [
  'ignore previous instructions',
  'ignore all previous',
  'disregard previous',
  'you are now',
  'new persona',
  'forget your instructions',
  'override your',
  'system prompt:',
  '###instruction',
];

const LINE_PREFIX_PATTERNS: RegExp[] = [
  /^SYSTEM:/i,
  /^\[SYSTEM\]/i,
];

export function scanForInjection(text: string): ScanResult {
  const findings: string[] = [];

  // 1. Invisible unicode scan
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    for (const [lo, hi, label] of INVISIBLE_RANGES) {
      if (cp >= lo && cp <= hi) {
        findings.push(`invisible unicode ${label} (U+${cp.toString(16).toUpperCase().padStart(4, '0')}) at offset ${i}`);
        break;
      }
    }
  }

  // 2. Injection phrase scan (case-insensitive, whole text)
  const lower = text.toLowerCase();
  for (const phrase of INJECTION_PHRASES) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      const line = text.slice(0, idx).split('\n').length;
      findings.push(`injection phrase "${phrase}" at line ${line}`);
      idx = lower.indexOf(phrase, idx + 1);
    }
  }

  // 3. Line-prefix pattern scan
  const lines = text.split('\n');
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln].trim();
    for (const re of LINE_PREFIX_PATTERNS) {
      if (re.test(line)) {
        findings.push(`injection line prefix "${line.slice(0, 40)}" at line ${ln + 1}`);
      }
    }
  }

  return { safe: findings.length === 0, findings };
}
