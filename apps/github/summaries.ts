import { createHash } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import {
  completedPeriod,
  zonedTimestamp,
  effectiveTimezone,
  timezoneLabel,
} from '../../src/core/timezone.js';
import type { AppContext, Message } from '../../src/core/types.js';
import type { GithubApi } from './api.js';
import { GithubInputError } from './errors.js';
import { label, link } from './notifications.js';
import { targetParts } from './subscriptions.js';

export interface Summary {
  id: string;
  author: string;
  cadence: 'daily' | 'weekly';
  scope: 'personal' | 'repositories' | 'organisation';
  targets: string[];
  approvedRepositories?: string[];
  channel?: string;
  time: string;
  weekday: number;
  timezone?: string;
  enabled: boolean;
  skipEmpty: boolean;
  lastAt: number;
  pendingAt?: number;
}
export const repoLink = (repo: string): string =>
  `[${label(repo)}](${link('https://github.com/' + repo)})`;
export async function channelLink(
  ctx: AppContext,
  channel: string,
): Promise<string> {
  const name = ctx.buzz.channelName
    ? await ctx.buzz.channelName(channel)
    : channel;
  return `[#${label(name)}](buzz://channel/${encodeURIComponent(channel)})`;
}
export function summarySchedule(
  s: Summary,
  config: AppContext['config'],
): string {
  const days = [
    'Sundays',
    'Mondays',
    'Tuesdays',
    'Wednesdays',
    'Thursdays',
    'Fridays',
    'Saturdays',
  ];
  return `${s.enabled ? 'Enabled' : 'Disabled'}${s.enabled ? `, ${s.cadence === 'weekly' ? days[s.weekday] + ' at ' : ''}${s.time} (${timezoneLabel(effectiveTimezone(config, s.timezone))})` : ''}`;
}
export function dueAt(
  s: Summary,
  config: AppContext['config'],
  now: number,
): number | undefined {
  if (!s.enabled) return;
  if (s.pendingAt) return s.pendingAt;
  const [h, m] = s.time.split(':').map(Number);
  const due = CronExpressionParser.parse(
    `${m} ${h} * * ${s.cadence === 'weekly' ? s.weekday : '*'}`,
    {
      tz: effectiveTimezone(config, s.timezone),
      currentDate: new Date(now + 1),
    },
  )
    .prev()
    .getTime();
  return due > s.lastAt ? due : undefined;
}
export async function validateSummary(
  ctx: AppContext,
  api: GithubApi,
  message: Message,
  raw: Summary,
): Promise<Summary> {
  if (
    !/^[a-z\d_-]{1,80}$/i.test(raw.id) ||
    !['daily', 'weekly'].includes(raw.cadence) ||
    !['personal', 'repositories', 'organisation'].includes(raw.scope)
  )
    throw new GithubInputError(
      'Choose a name, daily or weekly, and personal, repositories or organisation scope.',
    );
  if (
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time) ||
    !Number.isInteger(raw.weekday) ||
    raw.weekday < 0 ||
    raw.weekday > 6 ||
    typeof raw.enabled !== 'boolean' ||
    typeof raw.skipEmpty !== 'boolean'
  )
    throw new GithubInputError(
      'Choose a time (HH:MM), weekday (0–6), and Enabled or Disabled.',
    );
  try {
    effectiveTimezone(ctx.config, raw.timezone);
  } catch {
    throw new GithubInputError(
      'Choose a valid timezone or leave it blank to use the service default.',
    );
  }
  await api.account(message.author);
  if (
    raw.channel &&
    (raw.channel !== message.channel ||
      !(await ctx.buzz.canManage(raw.channel, message.author)))
  )
    throw new GithubInputError(
      'A channel owner or administrator must configure a summary from its destination channel.',
    );
  if (
    !Array.isArray(raw.targets) ||
    raw.targets.some((t) => typeof t !== 'string')
  )
    throw new GithubInputError('Provide repository names as a list.');
  const targets = [...new Set(raw.targets.map((t) => t.toLowerCase()))];
  let approvedRepositories: string[] | undefined;
  if (raw.scope === 'personal' && targets.length)
    throw new GithubInputError(
      'Personal summaries do not take repository filters. Choose repository scope instead.',
    );
  if (raw.scope === 'repositories') {
    if (!targets.length || targets.length > 100)
      throw new GithubInputError('Choose between 1 and 100 repositories.');
    for (const target of targets) {
      if (!targetParts(target).repo)
        throw new GithubInputError('Use OWNER/REPO for each repository.');
      await api.authorised(message.author, target);
    }
  }
  if (raw.scope === 'organisation') {
    if (targets.length !== 1 || targetParts(targets[0]).repo)
      throw new GithubInputError('Choose one organisation name.');
    await api.authorised(message.author, targets[0]);
    approvedRepositories = await api.approvedRepositories(
      message.author,
      targets[0],
    );
    if (!approvedRepositories.length || approvedRepositories.length > 100)
      throw new GithubInputError(
        'Organisation summaries support 1–100 repositories; select a smaller group if needed.',
      );
  }
  return {
    id: raw.id,
    author: message.author,
    cadence: raw.cadence,
    scope: raw.scope,
    targets,
    approvedRepositories,
    channel: raw.channel || undefined,
    time: raw.time,
    weekday: raw.weekday,
    timezone: raw.timezone || undefined,
    enabled: raw.enabled,
    skipEmpty: raw.skipEmpty,
    lastAt: Date.now(),
  };
}
export async function saveSummary(
  ctx: AppContext,
  api: GithubApi,
  message: Message,
  input: Summary,
): Promise<void> {
  const key = `${message.author}:${input.id}`;
  const existing = ctx.store.get<Summary>('github:summaries', key);
  if (existing?.channel && existing.channel !== message.channel)
    throw new GithubInputError(
      'Edit this summary from its destination channel.',
    );
  const s = await validateSummary(ctx, api, message, input);
  ctx.store.set('github:summaries', key, s);
  ctx.store.delete('github:summary-errors', key);
}
const fields = `totalCommitContributions totalIssueContributions totalPullRequestContributions totalPullRequestReviewContributions contributionCalendar{totalContributions} commitContributionsByRepository(maxRepositories:100){repository{nameWithOwner} contributions{totalCount}}`;
export async function summaryText(
  api: GithubApi,
  s: Summary,
  config: AppContext['config'],
  at = new Date(),
): Promise<{ body: string; empty: boolean }> {
  const zone = effectiveTimezone(config, s.timezone);
  const { from, to } = completedPeriod(at, zone, s.cadence === 'daily' ? 1 : 7);
  const date = (d: Date) =>
    new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      timeZone: zone,
    }).format(d);
  const period =
    s.cadence === 'daily'
      ? date(from)
      : `${date(from)}–${date(new Date(to.getTime() - 1))}`;
  const title = `📊 **${s.cadence === 'daily' ? 'Daily' : 'Weekly'} GitHub summary**`;
  const client =
    s.scope === 'personal'
      ? await api.contributions(s.author)
      : await api.user(s.author);
  if (s.scope === 'personal') {
    const previous = completedPeriod(from, zone, s.cadence === 'daily' ? 1 : 7);
    const data: any = await client.graphql(
      `query($from:DateTime!,$to:DateTime!,$previous:DateTime!,$previousTo:DateTime!){viewer{login current:contributionsCollection(from:$from,to:$to){${fields}} previous:contributionsCollection(from:$previous,to:$previousTo){contributionCalendar{totalContributions}}}}`,
      {
        from: zonedTimestamp(from, zone),
        to: zonedTimestamp(new Date(to.getTime() - 1), zone),
        previous: zonedTimestamp(previous.from, zone),
        previousTo: zonedTimestamp(new Date(from.getTime() - 1), zone),
      },
    );
    const c = data.viewer.current,
      total = c.contributionCalendar.totalContributions;
    const repos = c.commitContributionsByRepository.sort(
      (a: any, b: any) =>
        b.contributions.totalCount - a.contributions.totalCount,
    );
    const before = data.viewer.previous.contributionCalendar.totalContributions;
    const delta =
      s.cadence === 'weekly'
        ? `\n- **Previous week:** ${before} contributions${before ? `, ${Math.round(((total - before) / before) * 100)}% change` : ''}.`
        : '';
    return {
      empty: total === 0,
      body: `${title}\n**${label(data.viewer.login)}**, ${period}\n\n**${total} contributions**\n\n- **Commits:** ${c.totalCommitContributions}\n- **Pull requests:** ${c.totalPullRequestContributions}\n- **Issues:** ${c.totalIssueContributions}\n- **Reviews:** ${c.totalPullRequestReviewContributions}${delta}${s.cadence === 'weekly' ? '\n- **Repositories with commits:** ' + repos.length + (repos.length === 100 ? ' or more' : '') : ''}${
        repos.length
          ? '\n\n**Top repositories by commit contributions**\n' +
            repos
              .slice(0, 3)
              .map(
                (r: any) =>
                  `- ${repoLink(r.repository.nameWithOwner)}: ${r.contributions.totalCount}`,
              )
              .join('\n')
          : ''
      }\n\nGitHub contribution statistics (${timezoneLabel(zone)}).${config.githubContributionTokens?.[s.author] ? '' : '\nBreakdown covers repositories available to this GitHub App; the calendar total can include other contributions.'}`,
    };
  }
  let targets = s.targets;
  if (s.scope === 'organisation') {
    const current = await api.approvedRepositories(s.author, s.targets[0]);
    targets = (s.approvedRepositories ?? []).filter((r) => current.includes(r));
    if (targets.length !== s.approvedRepositories?.length)
      throw new GithubInputError(
        'Repository access changed. Review the organisation summary before sending it again.',
      );
  }
  const totals = {
    openedPR: 0,
    mergedPR: 0,
    openedIssue: 0,
    closedIssue: 0,
    commits: 0,
    reviews: 0,
    waiting: 0,
    failed: 0,
  };
  const failures: string[] = [];
  for (const target of targets) {
    try {
      await api.authorised(s.author, target);
      const { owner, repo } = targetParts(target);
      const range = `${from.toISOString()}..${new Date(to.getTime() - 1).toISOString()}`;
      const search = async (terms: string) => {
        const result = await client.request('GET /search/issues', {
          q: `repo:${target} ${terms}`,
          per_page: 1,
        });
        if (result.data.incomplete_results)
          throw new Error('Incomplete GitHub search');
        return result.data.total_count;
      };
      const row = { ...totals };
      for (const k of Object.keys(row) as (keyof typeof row)[]) row[k] = 0;
      row.openedPR = await search(`is:pr created:${range}`);
      row.mergedPR = await search(`is:pr merged:${range}`);
      row.openedIssue = await search(`is:issue created:${range}`);
      row.closedIssue = await search(`is:issue closed:${range}`);
      row.waiting = await search('is:pr is:open draft:false review:required');
      // Commit totals refer to the default branch, not every branch or person’s contribution graph.
      for (let page = 1; page <= 10; page++) {
        const r = await client.request('GET /repos/{owner}/{repo}/commits', {
          owner,
          repo: repo!,
          since: from.toISOString(),
          until: new Date(to.getTime() - 1).toISOString(),
          per_page: 100,
          page,
        });
        row.commits += r.data.length;
        if (r.data.length < 100) break;
        if (page === 10) throw new Error('Commit limit reached');
      }
      for (let page = 1; page <= 10; page++) {
        const r = await client.request('GET /repos/{owner}/{repo}/pulls', {
          owner,
          repo: repo!,
          state: 'all',
          sort: 'updated',
          direction: 'desc',
          per_page: 100,
          page,
        });
        let older = false;
        for (const pr of r.data) {
          if (Date.parse(pr.updated_at) < from.getTime()) {
            older = true;
            break;
          }
          const reviews = await client.paginate(
            'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
            { owner, repo: repo!, pull_number: pr.number, per_page: 100 },
          );
          row.reviews += reviews.filter(
            (r) =>
              r.submitted_at &&
              Date.parse(r.submitted_at) >= from.getTime() &&
              Date.parse(r.submitted_at) < to.getTime(),
          ).length;
        }
        if (older || r.data.length < 100) break;
        if (page === 10) throw new Error('Pull request limit reached');
      }
      const runs = await client.request(
        'GET /repos/{owner}/{repo}/actions/runs',
        { owner, repo: repo!, status: 'failure', created: range, per_page: 1 },
      );
      row.failed = runs.data.total_count;
      for (const k of Object.keys(row) as (keyof typeof row)[])
        totals[k] += row[k];
    } catch {
      failures.push(target);
    }
  }
  if (failures.length === targets.length)
    throw new GithubInputError(
      'No summary data is available. Check repository access and try again.',
    );
  const empty = !Object.values(totals).some(Boolean) && !failures.length;
  return {
    empty,
    body: `${title}${failures.length ? ' (partial)' : ''}\n${targets.map(repoLink).join(', ')}\n${period}\n\n- **Pull requests:** ${totals.openedPR} opened, ${totals.mergedPR} merged.\n- **Issues:** ${totals.openedIssue} opened, ${totals.closedIssue} closed.\n- **Commits to default branches:** ${totals.commits}\n- **Reviews:** ${totals.reviews}\n\n👀 **Needs attention**\n- ${totals.waiting} pull requests waiting for review.\n- ${totals.failed} failed workflow runs from this period.${failures.length ? '\n\nSome repository data could not be fetched. Totals exclude those repositories; check your summary settings.' : ''}`,
  };
}
export async function deliverSummaries(
  ctx: AppContext,
  api: GithubApi,
  now = Date.now(),
): Promise<void> {
  for (const { key, value: s } of ctx.store.list<Summary>('github:summaries')) {
    const failure = ctx.store.get<{ nextAt: number; attempts: number }>(
      'github:summary-errors',
      key,
    );
    if (failure && failure.nextAt > now) continue;
    const due = dueAt(s, ctx.config, now);
    if (due === undefined) continue;
    const id = createHash('sha256').update(`${key}:${due}`).digest('hex');
    try {
      ctx.store.set('github:summaries', key, { ...s, pendingAt: due });
      if (s.channel && !(await ctx.buzz.canManage(s.channel, s.author)))
        throw new GithubInputError(
          'Summary owner no longer manages its channel.',
        );
      if (!ctx.store.get('github:summary-deliveries', id)) {
        const rendered = await summaryText(api, s, ctx.config, new Date(due));
        if (!rendered.empty || !s.skipEmpty) {
          const opts = { dedupKey: `github:summary:${id}` };
          if (s.channel) await ctx.buzz.send(s.channel, rendered.body, opts);
          else await ctx.buzz.dm(s.author, rendered.body, opts);
        }
        ctx.store.set('github:summary-deliveries', id, true);
      }
      ctx.store.set('github:summaries', key, {
        ...s,
        lastAt: now,
        pendingAt: undefined,
      });
      ctx.store.delete('github:summary-errors', key);
    } catch (error) {
      ctx.store.set('github:summary-errors', key, {
        at: now,
        attempts: (failure?.attempts ?? 0) + 1,
        nextAt:
          now +
          Math.min(3600000, 60000 * 2 ** Math.min(failure?.attempts ?? 0, 6)),
        status: (error as { status?: number }).status ?? 'unavailable',
      });
      ctx.log.warn(
        { summary: key, status: (error as { status?: number }).status },
        'Activity summary failed; it will retry',
      );
    }
  }
}
