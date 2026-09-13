import { belongsToRepository } from './canonical.js';
import { nip19 } from 'nostr-tools';
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
export function formatNotification(
  event: string,
  payload: any,
): Notification | undefined {
  const repo = payload.repository?.full_name;
  if (!repo) return;
  const actor = label(payload.sender?.login ?? 'GitHub');
  const action = String(payload.action ?? 'updated');
  const issue = payload.issue ?? payload.pull_request;
  const logins = [
    payload.assignee?.login,
    payload.requested_reviewer?.login,
    ...(issue?.assignees ?? []).map((item: any) => item.login),
    ...(issue?.requested_reviewers ?? []).map((item: any) => item.login),
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
    const state = issue.merged ? 'merged' : issue.draft ? 'draft' : issue.state;
    const title = `${kind} #${issue.number}: ${label(issue.title)}`;
    const summary = `**${label(repo)}**\n[${title}](${link(issue.html_url)})\n**${label(state)}**${issue.user?.login ? `, opened by ${label(issue.user.login)}` : ''}${issue.labels?.length ? `\nLabels: ${issue.labels.map((item: any) => label(item.name)).join(', ')}` : ''}`;
    const reply = payload.comment
      ? `${actor} commented:\n\n${plain(payload.comment.body)}\n\n[View comment](${link(payload.comment.html_url)})`
      : payload.review
        ? `${actor} reviewed: **${label(payload.review.state)}**\n\n${plain(payload.review.body)}\n\n[View review](${link(payload.review.html_url)})`
        : ['opened', 'edited', 'labeled', 'unlabeled', 'synchronize'].includes(
              action,
            )
          ? undefined
          : `${actor} ${label(issue.merged && action === 'closed' ? 'merged' : action.replaceAll('_', ' '))} [#${issue.number}](${link(issue.html_url)}).`;
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
    const commits = (payload.commits ?? []).slice(0, 8);
    const count = payload.commits?.length ?? 0;
    return {
      key: `${repo}:push:${payload.after}`,
      title: `${count} commit${count === 1 ? '' : 's'}`,
      body: `**${label(repo)}**, ${label(String(payload.ref).replace('refs/heads/', ''))}\n${actor} pushed ${count} commit${count === 1 ? '' : 's'}:\n${commits.map((commit: any) => `- [${String(commit.id).slice(0, 7)}](${link(commit.url)}) ${label(String(commit.message).split('\n')[0])}`).join('\n')}${count > 8 ? `\n[View all commits](${link(payload.compare)})` : ''}`,
      url: link(payload.compare),
      logins: [],
    };
  }
  if (event === 'workflow_run') {
    const run = payload.workflow_run;
    if (!run) return;
    return {
      key: `${repo}:workflow:${run.id}`,
      title: label(run.name),
      body: `**${label(repo)}**\n[${label(run.name)} #${run.run_number}](${link(run.html_url)})\n**${label(run.conclusion ?? run.status)}**, ${label(run.head_branch)}\nTriggered by ${label(run.actor?.login ?? payload.sender?.login)}`,
      url: link(run.html_url),
      important: run.status === 'completed',
      logins: [],
    };
  }
  if (event === 'release') {
    const release = payload.release;
    if (!release) return;
    return {
      key: `${repo}:release:${release.id}`,
      title: label(release.name ?? release.tag_name),
      body: `**${label(repo)}**\n[Release ${label(release.name ?? release.tag_name)}](${link(release.html_url)})${release.prerelease ? ' (prerelease)' : ''}\n\n${plain(release.body)}`,
      url: link(release.html_url),
      logins: [],
    };
  }
  if (event === 'deployment' || event === 'deployment_status') {
    const deployment = payload.deployment;
    if (!deployment) return;
    return {
      key: `${repo}:deployment:${deployment.id}`,
      title: `Deployment to ${label(deployment.environment)}`,
      body: `**${label(repo)}**\nDeployment to **${label(deployment.environment)}**: **${label(payload.deployment_status?.state ?? 'created')}**\nRef: ${label(deployment.ref)}${payload.deployment_status?.description ? `\n${plain(payload.deployment_status.description)}` : ''}`,
      url: `https://github.com/${repo}/deployments`,
      logins: [],
    };
  }
  if (event === 'create' || event === 'delete')
    return {
      key: `${repo}:branch:${payload.ref}:${event}:${payload.sender?.id}`,
      title: 'Branch updated',
      body: `**${label(repo)}**\n${actor} ${event === 'create' ? 'created' : 'deleted'} branch **${label(payload.ref)}**.`,
      url: `https://github.com/${repo}/branches`,
      logins: [],
    };
  if (event === 'discussion' || event === 'discussion_comment') {
    const discussion = payload.discussion;
    if (!discussion) return;
    return {
      key: `${repo}:discussion:${discussion.number}`,
      title: label(discussion.title),
      body: `**${label(repo)}**\n[Discussion #${discussion.number}: ${label(discussion.title)}](${link(discussion.html_url)})\n${label(discussion.state ?? action)}`,
      url: link(discussion.html_url),
      reply: payload.comment
        ? `${actor} commented:\n\n${plain(payload.comment.body)}`
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
  const bodyMentions = [
    ...[
      notification.body,
      notification.reply ?? '',
      current.issue?.body ?? current.pull_request?.body ?? '',
    ]
      .join('\n')
      .matchAll(/(?<![\w])@([a-z\d-]+)/gi),
  ].map((match) => match[1]);
  const logins = [
    ...notification.logins,
    ...(current.linkedTeamLogins ?? []),
    ...bodyMentions,
  ];
  const linked = accounts.filter((account) =>
    logins.some((login) => login.toLowerCase() === account.login.toLowerCase()),
  );
  const mentions = linked.map((account) => account.pubkey);
  if (linked.length)
    notification.body += `\n\n${linked.map((account) => `[${label(account.login)}](nostr:${nip19.npubEncode(account.pubkey)})`).join(', ')}`;
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
        { mentions, dedupKey: `github:${deliveryKey}:parent` },
      );
      context.store.set('github:objects', key, {
        id: parentId,
        body: notification.body,
      });
    } else if (existing.body !== notification.body) {
      await context.buzz.send(subscription.channel, notification.body, {
        edit: existing.id,
        mentions,
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
