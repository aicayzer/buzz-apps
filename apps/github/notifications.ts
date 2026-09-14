import { belongsToRepository } from './canonical.js';
import { activeProse } from './prose.js';
import type { AppContext, Subscription } from '../../src/core/types.js';
import type { GithubApi } from './api.js';
import { matchesSubscription } from './subscriptions.js';

export interface Notification {
  key: string;
  title: string;
  body: string;
  url: string;
  reply?: string;
  important?: boolean;
  logins: string[];
}
export function plain(value: unknown, limit = 1400): string {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/nostr:/gi, 'nostr\\:')
    .slice(0, limit);
}
export function label(value: unknown): string {
  return plain(value, 200)
    .replace(/[[\]`*_<>]/g, '\\$&')
    .replace(/\n/g, ' ');
}
export function link(value: unknown): string {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === 'github.com'
      ? url.href.replace(/[()]/g, (char) => encodeURIComponent(char))
      : 'https://github.com';
  } catch {
    return 'https://github.com';
  }
}
export function actorLink(login: unknown): string {
  return login
    ? `[${label(login)}](${link('https://github.com/' + String(login))})`
    : 'GitHub';
}
export function formatNotification(
  event: string,
  payload: any,
): Notification | undefined {
  const repo = payload.repository?.full_name;
  if (!repo) return;
  const repository = `[${label(repo)}](${link('https://github.com/' + repo)})`;
  const actor = actorLink(payload.sender?.login);
  const action = String(payload.action ?? 'updated');
  const issue = payload.issue ?? payload.pull_request;
  const logins = [
    ...(action === 'assigned' ? [payload.assignee?.login] : []),
    ...(action === 'review_requested'
      ? [payload.requested_reviewer?.login]
      : []),
    ...(action === 'opened'
      ? (issue?.assignees ?? []).map((item: any) => item.login)
      : []),
  ].filter(Boolean);
  if (
    issue &&
    [
      'issues',
      'pull_request',
      'issue_comment',
      'pull_request_review',
      'pull_request_review_comment',
    ].includes(event)
  ) {
    const kind =
      issue.pull_request || payload.pull_request ? 'Pull request' : 'Issue';
    const state = issue.merged
      ? 'merged'
      : issue.draft && issue.state !== 'closed'
        ? 'draft'
        : issue.state;
    const icon =
      state === 'merged' || state === 'closed'
        ? '✅'
        : state === 'draft'
          ? '📝'
          : kind === 'Issue'
            ? '🟢'
            : '🔀';
    const title = `${kind} #${issue.number}: ${label(issue.title)}`;
    const heading =
      state === 'draft'
        ? 'Draft pull request'
        : `${kind} ${state === 'open' ? 'opened' : label(state)}`;
    const summary = `${icon} **${heading}**\n${repository}\n[#${issue.number}: ${label(issue.title)}](${link(issue.html_url)})${issue.user?.login ? `\n\n- Author: ${actorLink(issue.user.login)}` : ''}${issue.base?.ref ? `\n- Branch: ${label(issue.head?.ref)} → ${label(issue.base.ref)}` : ''}${issue.labels?.length ? `\n- Labels: ${issue.labels.map((item: any) => label(item.name)).join(', ')}` : ''}`;
    let reply: string | undefined;
    if (payload.comment)
      reply = `💬 **${actor} commented**\n\n${plain(payload.comment.body)}\n\n[View comment](${link(payload.comment.html_url)})`;
    else if (payload.review) {
      const states: Record<string, string> = {
        approved: '✅ **Approved',
        changes_requested: '✏️ **Changes requested',
        commented: '💬 **Review',
        dismissed: '⚪ **Review dismissed',
      };
      reply = `${states[String(payload.review.state).toLowerCase()] ?? '💬 **Review'} by ${actor}**${payload.review.body ? '\n\n' + plain(payload.review.body) : ''}\n\n[View review](${link(payload.review.html_url)})`;
    } else if (
      !['opened', 'edited', 'labeled', 'unlabeled', 'synchronize'].includes(
        action,
      )
    ) {
      if (action === 'review_requested')
        reply = `👀 **Review requested**\n${actor} requested a review${payload.requested_reviewer?.login ? ' from ' + actorLink(payload.requested_reviewer.login) : payload.requested_team?.name ? ' from ' + label(payload.requested_team.name) : ''}.`;
      else
        reply = `${icon} **${action === 'ready_for_review' ? 'Ready for review' : kind + ' ' + label(issue.merged && action === 'closed' ? 'merged' : action.replaceAll('_', ' '))}**\nBy ${actor}. [View #${issue.number}](${link(issue.html_url)})`;
    }
    return {
      key: `${repo}:issue:${issue.number}`,
      title,
      body: summary,
      url: link(issue.html_url),
      reply,
      important: ['closed', 'reopened', 'ready_for_review'].includes(action),
      logins,
    };
  }
  if (event === 'push') {
    const commits = (payload.commits ?? []).slice(0, 8),
      count = payload.commits?.length ?? 0;
    return {
      key: `${repo}:push:${payload.after}`,
      title: `${count} commits`,
      body: `📦 **${count} commit${count === 1 ? '' : 's'} pushed**\n${repository}, ${label(String(payload.ref).replace('refs/heads/', ''))}\n\n${commits.map((c: any) => `- [${String(c.id).slice(0, 7)}](${link(c.url)}) ${label(String(c.message).split('\n')[0])}`).join('\n')}${count > 8 ? '\n- ' + (count - 8) + ' more commits.' : ''}\n\nPushed by ${actor}. [Compare changes](${link(payload.compare)})`,
      url: link(payload.compare),
      logins: [],
    };
  }
  if (event === 'workflow_run') {
    const run = payload.workflow_run;
    if (!run) return;
    const state = run.conclusion ?? run.status;
    const words: Record<string, string> = {
      success: 'passed',
      failure: 'failed',
      in_progress: 'is running',
      queued: 'is queued',
      waiting: 'is waiting',
      action_required: 'needs attention',
      cancelled: 'cancelled',
      timed_out: 'timed out',
      skipped: 'skipped',
      neutral: 'completed',
    };
    const icon =
      state === 'success'
        ? '✅'
        : ['failure', 'timed_out'].includes(state)
          ? '❌'
          : ['cancelled', 'skipped', 'neutral'].includes(state)
            ? '⚪'
            : '⏳';
    return {
      key: `${repo}:workflow:${run.id}`,
      title: label(run.name),
      body: `${icon} **${label(run.name)} ${words[state] ?? label(state)}**\n${repository}\n\n- Branch: ${label(run.head_branch)}\n- Run: [#${run.run_number}](${link(run.html_url)})\n- Triggered by: ${actorLink(run.actor?.login ?? payload.sender?.login)}`,
      url: link(run.html_url),
      important: run.status === 'completed',
      logins: [],
    };
  }
  if (event === 'release') {
    const r = payload.release;
    if (!r) return;
    const notes = plain(r.body)
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !/^#{1,6}\s|^full changelog:|^\*\*full changelog|^\*?\s*@\S+ made their first contribution/i.test(
            l,
          ),
      )
      .slice(0, 3)
      .map((l) => '- ' + l.replace(/^[-*]\s+/, ''));
    return {
      key: `${repo}:release:${r.id}`,
      title: label(r.name || r.tag_name),
      body: `${r.prerelease ? '🧪' : '📦'} **${r.prerelease ? 'Pre-release' : 'Release'} ${label(r.name || r.tag_name)}**\n${repository}${notes.length ? '\n\n' + notes.join('\n') : ''}\n\n[Read release notes](${link(r.html_url)})`,
      url: link(r.html_url),
      logins: [],
    };
  }
  if (event === 'deployment' || event === 'deployment_status') {
    const d = payload.deployment;
    if (!d) return;
    const state = payload.deployment_status?.state ?? 'pending';
    const heading =
      state === 'success'
        ? 'Deployed to'
        : state === 'failure' || state === 'error'
          ? 'Deployment failed in'
          : 'Deploying to';
    return {
      key: `${repo}:deployment:${d.id}`,
      title: `Deployment to ${label(d.environment)}`,
      body: `${state === 'success' ? '✅' : state === 'failure' || state === 'error' ? '❌' : '⏳'} **${heading} ${label(d.environment)}**\n${repository}\n\n- Ref: ${label(d.ref)}\n- Status: ${label(state)}${payload.deployment_status?.description ? '\n- ' + plain(payload.deployment_status.description) : ''}\n\n[View deployment](${link('https://github.com/' + repo + '/deployments')})`,
      url: `https://github.com/${repo}/deployments`,
      logins: [],
    };
  }
  if (event === 'create' || event === 'delete')
    return {
      key: `${repo}:branch:${payload.ref}:${event}:${payload.sender?.id}`,
      title: 'Branch updated',
      body: `🌿 **Branch ${event === 'create' ? 'created' : 'deleted'}**\n${repository}\n\n- Branch: ${label(payload.ref)}\n- By: ${actor}`,
      url: `https://github.com/${repo}/branches`,
      logins: [],
    };
  if (event === 'discussion' || event === 'discussion_comment') {
    const d = payload.discussion;
    if (!d) return;
    return {
      key: `${repo}:discussion:${d.number}`,
      title: label(d.title),
      body: `💬 **Discussion ${label(d.state ?? action)}**\n${repository}\n[#${d.number}: ${label(d.title)}](${link(d.html_url)})`,
      url: link(d.html_url),
      reply: payload.comment
        ? `💬 **${actor} replied**\n\n${plain(payload.comment.body)}`
        : undefined,
      logins: [],
    };
  }
}
export async function deliverWebhook(
  context: AppContext,
  api: GithubApi,
  subscriptions: Subscription[],
  event: string,
  raw: unknown,
  delivery: string,
): Promise<void> {
  if (!raw || typeof raw !== 'object') return;
  const payload = raw as any;
  if (event === 'installation' && payload.action === 'deleted') {
    context.log.warn(
      { installation: payload.installation?.id },
      'GitHub installation removed',
    );
    return;
  }
  const matching = subscriptions.filter((subscription) =>
    matchesSubscription(subscription, event, payload),
  );
  if (!matching.length) return;
  // Replace mutable object fields with GitHub's latest state before editing a parent.
  // Comments keep their original payload so each authored reply is delivered once.
  let current = payload;
  const repo = payload.repository?.name;
  const owner = payload.repository?.owner?.login;
  if (owner && repo) {
    const client = await api.installation(owner, repo);
    if (payload.pull_request) {
      const item = await client.request(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        { owner, repo, pull_number: payload.pull_request.number },
      );
      current = { ...payload, pull_request: item.data };
    } else if (payload.issue) {
      const item = await client.request(
        'GET /repos/{owner}/{repo}/issues/{issue_number}',
        { owner, repo, issue_number: payload.issue.number },
      );
      current = { ...payload, issue: item.data };
    } else if (payload.workflow_run) {
      const item = await client.request(
        'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
        { owner, repo, run_id: payload.workflow_run.id },
      );
      current = { ...payload, workflow_run: item.data };
    } else if (payload.deployment) {
      const statuses = await client.request(
        'GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses',
        { owner, repo, deployment_id: payload.deployment.id, per_page: 1 },
      );
      if (statuses.data[0])
        current = { ...payload, deployment_status: statuses.data[0] };
    }
    if (payload.requested_team?.slug) {
      const members = await client.paginate(
        'GET /orgs/{org}/teams/{team_slug}/members',
        { org: owner, team_slug: payload.requested_team.slug, per_page: 100 },
      );
      current = {
        ...current,
        linkedTeamLogins: members.map((member) => member.login),
      };
    }
  }
  const resourceTarget = String(payload.repository?.full_name ?? '');
  const resources = [
    current.issue,
    current.pull_request,
    current.comment,
    current.review,
    current.workflow_run,
  ].filter(Boolean);
  if (
    resources.some((resource) => !belongsToRepository(resourceTarget, resource))
  ) {
    context.log.info(
      { event },
      'Skipped a GitHub resource outside its original repository',
    );
    return;
  }
  const notification = formatNotification(event, current);
  if (!notification) return;
  const accounts = context.store
    .list<unknown>('accounts')
    .map((row) => context.store.account(row.key))
    .filter((account) => account !== undefined);
  const authoredText =
    current.comment?.body ??
    current.review?.body ??
    (current.action === 'opened'
      ? (current.issue?.body ?? current.pull_request?.body)
      : '') ??
    '';
  const bodyMentions = [
    ...activeProse(authoredText).matchAll(/(?<![\w/])@([a-z\d-]+)(?![\w])/gi),
  ].map((match) => match[1]);
  const logins = [
    ...notification.logins,
    ...(current.action === 'review_requested'
      ? (current.linkedTeamLogins ?? [])
      : []),
    ...bodyMentions,
  ];
  const linked = accounts.filter((account) =>
    logins.some((login) => login.toLowerCase() === account.login.toLowerCase()),
  );
  const mentions = linked.map((account) => account.pubkey);
  if (linked.length) {
    const profiles = await context.buzz.query([
      { kinds: [0], authors: mentions },
    ]);
    const names = linked.map((account) => {
      const latest = profiles
        .filter((profile) => profile.pubkey === account.pubkey)
        .sort((a, b) => b.created_at - a.created_at)[0];
      let name = account.pubkey;
      try {
        const profile = JSON.parse(latest?.content ?? '{}');
        name =
          String(profile.display_name || profile.name || name).trim() || name;
      } catch {
        /* Keep a bound key reference when profile metadata is unavailable. */
      }
      return '@' + label(name);
    });
    const suffix = '\n\nMentioned: ' + names.join(', ');
    if (notification.reply) notification.reply += suffix;
    else notification.body += suffix;
  }
  const seenChannels = new Set<string>();
  for (const subscription of matching) {
    if (seenChannels.has(subscription.channel)) continue;
    seenChannels.add(subscription.channel);
    const deliveryKey = `${subscription.channel}:${delivery}`;
    if (context.store.get('github:delivered', deliveryKey)) continue;
    const key = `${subscription.channel}:${notification.key}`;
    const existing = context.store.get<{ id: string; body: string }>(
      'github:objects',
      key,
    );
    const threaded = subscription.settings.threading !== false;
    let parentId = existing?.id;
    if (!existing || !threaded) {
      parentId = await context.buzz.send(
        subscription.channel,
        notification.body,
        {
          mentions: notification.reply ? [] : mentions,
          dedupKey: `github:${deliveryKey}:parent`,
        },
      );
      context.store.set('github:objects', key, {
        id: parentId,
        body: notification.body,
      });
    } else if (existing.body !== notification.body) {
      await context.buzz.send(subscription.channel, notification.body, {
        edit: existing.id,
        mentions: [],
        dedupKey: `github:${deliveryKey}:edit`,
      });
      context.store.set('github:objects', key, {
        id: existing.id,
        body: notification.body,
      });
    }
    if (notification.reply) {
      const broadcast =
        notification.important ||
        (event === 'pull_request_review' &&
          subscription.settings.broadcastReviews === true) ||
        (['issue_comment', 'pull_request_review_comment'].includes(event) &&
          subscription.settings.broadcastComments === true);
      const objectId = current.comment?.id ?? current.review?.id;
      const replyKey = objectId ? `${key}:reply:${objectId}` : undefined;
      const previousReply = replyKey
        ? context.store.get<string>('github:replies', replyKey)
        : undefined;
      const deleted = current.action === 'deleted';
      if (!deleted || previousReply) {
        const replyId = await context.buzz.send(
          subscription.channel,
          deleted ? 'Comment deleted on GitHub.' : notification.reply,
          {
            root: threaded ? parentId : undefined,
            edit: previousReply,
            broadcast,
            mentions,
            dedupKey: `github:${deliveryKey}:reply`,
          },
        );
        if (replyKey)
          context.store.set(
            'github:replies',
            replyKey,
            previousReply ?? replyId,
          );
      }
    }
    context.store.set('github:delivered', deliveryKey, true);
  }
}
