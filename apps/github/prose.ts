/** Exclude quoted examples and code from automatic link/mention detection. */
export function activeProse(content: string): string {
  let fence: { char: string; length: number } | undefined;
  const lines: string[] = [];
  let quoted = false;
  for (const line of content.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        /^\s*$/.test(line.slice(marker[0].length))
      )
        fence = undefined;
      continue;
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      continue;
    }
    if (!line.trim()) quoted = false;
    if (/^\s*>/.test(line)) quoted = true;
    if (quoted || /^(?: {4}|\t)/.test(line)) continue;
    lines.push(line);
  }
  // Matching backtick runs may span lines. Unclosed runs are omitted conservatively.
  return lines.join('\n').replace(/(`+)([\s\S]*?)\1(?!`)|`+[\s\S]*$/g, '');
}
