import type { Message } from '../../src/core/types.js';
import type { Summary } from './summaries.js';
import { GithubInputError } from './errors.js';

export const SUMMARY_HELP = `Use summaries set NAME --cadence daily|weekly --scope personal|repositories|organisation --time HH:MM --destination here|private. Add --repos OWNER/REPO,OWNER/OTHER or --org OWNER, --day monday, --timezone Europe/London and --skip-empty true|false as needed. Use summaries NAME to edit in a browser.`;
export function summaryInput(
  id: string,
  tokens: string[],
  message: Message,
  existing?: Summary,
): { input: Summary; missing: string[] } {
  const input = {
    id,
    author: message.author,
    targets: [],
    weekday: 1,
    enabled: true,
    skipEmpty: true,
    lastAt: 0,
    ...existing,
  } as Summary;
  const allowed = [
    'cadence',
    'scope',
    'time',
    'destination',
    'repos',
    'org',
    'day',
    'timezone',
    'skip-empty',
    'enabled',
  ];
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length; i += 2) {
    const name = tokens[i].replace(/^--/, '');
    const value = tokens[i + 1];
    if (
      !tokens[i].startsWith('--') ||
      !allowed.includes(name) ||
      value === undefined ||
      value.startsWith('--') ||
      seen.has(name)
    )
      throw new GithubInputError(SUMMARY_HELP);
    seen.add(name);
    switch (name) {
      case 'cadence':
        input.cadence = value as Summary['cadence'];
        break;
      case 'scope':
        input.scope = value as Summary['scope'];
        break;
      case 'time':
        input.time = value;
        break;
      case 'destination':
        if (!['here', 'private'].includes(value))
          throw new GithubInputError(
            'Use --destination here for this channel or --destination private for a private summary.',
          );
        input.channel = value === 'here' ? message.channel : undefined;
        break;
      case 'repos':
      case 'org':
        input.targets = value.split(',').map((v) => v.trim());
        break;
      case 'timezone':
        input.timezone = value === 'default' ? undefined : value;
        break;
      case 'day':
        input.weekday = [
          'sunday',
          'monday',
          'tuesday',
          'wednesday',
          'thursday',
          'friday',
          'saturday',
        ].indexOf(value.toLowerCase());
        break;
      case 'enabled':
      case 'skip-empty':
        if (!['true', 'false'].includes(value))
          throw new GithubInputError(`Use --${name} true or --${name} false.`);
        input[name === 'enabled' ? 'enabled' : 'skipEmpty'] = value === 'true';
        break;
    }
  }
  if (seen.has('repos') && seen.has('org'))
    throw new GithubInputError(
      'Choose repositories or an organisation, not both.',
    );
  if (
    seen.has('scope') &&
    input.scope === 'personal' &&
    !seen.has('repos') &&
    !seen.has('org')
  )
    input.targets = [];
  const missing = ['cadence', 'scope', 'time'].filter(
    (k) => !input[k as keyof Summary],
  );
  if (!existing && !seen.has('destination')) missing.push('destination');
  if (input.scope === 'repositories' && !input.targets.length)
    missing.push('repos');
  if (input.scope === 'organisation' && !input.targets.length)
    missing.push('org');
  return { input, missing };
}
